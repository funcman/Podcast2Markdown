import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  transcribe,
  init as initWhisper,
  transcribeWithCheckpoint,
  computeTotalChunks,
} from "@/lib/whisper";
import { recoverGpuMemory } from "@/lib/gpu-memory";
import path from "path";
import { writeFile, readFile, mkdir, rm, unlink } from "fs/promises";
import { existsSync } from "fs";
import { convertToWav, getAudioInfo, isFfmpegInstalled, FfmpegNotInstalledError } from "@/lib/audio-converter";
import { detectLanguage } from "@/lib/detect-language";
import { mergeBilingualTranscripts } from "@/lib/merge-transcripts";

export const runtime = "nodejs";

let whisperInitialized = false;

async function ensureWhisperInitialized() {
  if (!whisperInitialized) {
    await initWhisper();
    whisperInitialized = true;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { audioId, forceTranscribe, language } = body as {
      audioId?: string;
      forceTranscribe?: boolean;
      language?: string; // 'auto' | 'zh' | 'en' | 'ja' 等 whisper.cpp 支持的语言代码
    };

    if (!audioId) {
      return NextResponse.json({ error: "audioId required" }, { status: 400 });
    }

    // 默认 auto：让 whisper.cpp 自己逐段检测语言
    // 中文播客纯中文也 OK（auto 检测准确率很高）
    // 中英混杂必须 auto（之前硬编码 'zh' 把英文强转中文造成灾难）
    const effectiveLanguage = language || "auto";

    // 创建任务记录
    const task = await prisma.task.create({
      data: {
        type: "transcribe",
        status: "pending",
        progress: 0,
        audioId,
      },
    });

    // 异步处理转录
    console.log(
      `[Transcribe] Created task ${task.id}, audioId: ${audioId}, forceTranscribe=${!!forceTranscribe}, language=${effectiveLanguage}`,
    );
    processTranscribe(task.id, audioId, !!forceTranscribe, effectiveLanguage).catch((err) => {
      console.error(`[Transcribe] Task ${task.id} failed:`, err.message);
      // task 标 failed
      prisma.task.update({
        where: { id: task.id },
        data: { status: "failed", error: err.message },
      }).catch(() => {});
      // audioFile 也要标 failed，否则状态会卡在 transcribing 导致前端看不到
      prisma.audioFile.update({
        where: { id: audioId },
        data: { status: "failed" },
      }).catch(() => {});
    });

    return NextResponse.json({ taskId: task.id });
  } catch (error) {
    console.error("Transcribe error:", error);
    return NextResponse.json({ error: "Transcribe failed" }, { status: 500 });
  }
}

async function processTranscribe(
  taskId: string,
  audioId: string,
  forceTranscribe: boolean,
  language: string = "auto",
) {
  console.log(`[Transcribe] Task ${taskId} started for audio ${audioId}`);

  // 更新状态为处理中
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "processing", progress: 10 },
  });

  // 转录前检测 ffmpeg 是否安装
  const ffmpegInstalled = await isFfmpegInstalled();
  if (!ffmpegInstalled) {
    const errorMsg = "FFmpeg is not installed or not found in PATH";
    console.error(`[Transcribe] ${errorMsg}`);
    await prisma.task.update({
      where: { id: taskId },
      data: { status: "failed", error: errorMsg },
    });
    return;
  }

  // 获取音频文件
  const audioFile = await prisma.audioFile.findUnique({ where: { id: audioId } });
  if (!audioFile) {
    console.error(`[Transcribe] Audio file ${audioId} not found`);
    throw new Error("Audio file not found");
  }

  console.log(
    `[Transcribe] Found audio file: ${audioFile.fileName}, size: ${audioFile.fileSize}, hash: ${audioFile.contentHash?.slice(0, 12) ?? "n/a"}`,
  );

  // ===== force 重跑 = 删旧 transcript，避免下面的 create() 撞 unique constraint =====
  if (forceTranscribe) {
    try {
      const deleted = await prisma.transcript.deleteMany({
        where: { audioFileId: audioId },
      });
      if (deleted.count > 0) {
        console.log(
          `[Transcribe] forceTranscribe=true, deleted ${deleted.count} old transcript(s) for ${audioId}`,
        );
      }
    } catch (e) {
      console.warn(`[Transcribe] failed to delete old transcript (continuing):`, e);
    }
  }

  // ===== 断点复用：检查同 contentHash 是否已有 completed Transcript =====
  // 复用策略：
  //   1. AudioFile.contentHash 必须存在（上传时算过）
  //   2. !forceTranscribe（前端没强制要求重跑）
  //   3. 库里有同 hash 且 transcript.status === 'completed' 的历史记录
  // 满足条件 → 复制那份 transcript 关联到当前 audioId，跳过 ffmpeg + whisper。
  if (!forceTranscribe && audioFile.contentHash) {
    const cached = await prisma.audioFile.findFirst({
      where: {
        contentHash: audioFile.contentHash,
        id: { not: audioId },
        transcript: { status: "completed" },
      },
      include: { transcript: true },
      orderBy: { createdAt: "asc" },
    });

    if (cached?.transcript) {
      console.log(
        `[Transcribe] Reusing transcript from audio ${cached.id} (hash ${audioFile.contentHash.slice(0, 12)})`,
      );

      // 新建一份 Transcript 关联到当前 audioId。
      // （Prisma AudioFile ↔ Transcript 是 1:1，必须新建行不能复用）
      await prisma.transcript.create({
        data: {
          audioFileId: audioId,
          language: cached.transcript.language,
          fullText: cached.transcript.fullText,
          segments: cached.transcript.segments,
          status: "completed",
        },
      });

      // 把 raw.txt 也复制一份（生成文章步骤会读）
      const uploadDir = path.join(process.cwd(), "uploads", audioId);
      const rawTextPath = path.join(uploadDir, "raw.txt");
      await writeFile(rawTextPath, cached.transcript.fullText, "utf-8");
      console.log(`[Transcribe] Raw transcript copied to: ${rawTextPath}`);

      await prisma.audioFile.update({
        where: { id: audioId },
        data: { status: "completed" }, // 复用 = 转录已完成（虽然没真跑）
      });

      await prisma.task.update({
        where: { id: taskId },
        data: { progress: 100, status: "waiting_for_prompt" },
      });
      console.log(
        `[Transcribe] Task ${taskId} reused transcript, waiting for prompt confirmation`,
      );
      return;
    }
    console.log(
      `[Transcribe] No reusable transcript for hash ${audioFile.contentHash.slice(0, 12)}, falling back to full transcription`,
    );
  }

  // ===== 正常流程：转码 + whisper 转录 =====

  // 检查音频格式，决定是否需要转换
  let audioPath = audioFile.filePath;
  const sourcePath = audioFile.originalPath || audioFile.filePath;

  try {
    const audioInfo = await getAudioInfo(sourcePath);
    console.log(`[Transcribe] Audio format: ${audioInfo.format}, duration: ${audioInfo.duration}s`);

    if (audioInfo.format.toLowerCase() === "wav" && audioInfo.sampleRate === 16000) {
      // WAV 格式且已经是 16kHz，直接使用原始文件
      console.log(`[Transcribe] WAV 16kHz format detected, skipping conversion`);
      audioPath = sourcePath;
      // 更新 filePath 和时长
      await prisma.audioFile.update({
        where: { id: audioId },
        data: {
          filePath: sourcePath,
          duration: audioInfo.duration,
          status: "ready",
        },
      });
    } else {
      // 其他格式需要转换为 WAV
      console.log(`[Transcribe] Converting ${audioInfo.format} to WAV...`);
      await prisma.audioFile.update({
        where: { id: audioId },
        data: { status: "converting" },
      });

      const outputPath = path.join(process.cwd(), "uploads", audioId, "converted.wav");
      await convertToWav(sourcePath, outputPath);

      // 转换完成后获取准确的时长信息
      const convertedInfo = await getAudioInfo(outputPath);
      console.log(`[Transcribe] Conversion complete, duration: ${convertedInfo.duration}s`);

      // 更新 AudioFile 记录
      audioPath = outputPath;
      await prisma.audioFile.update({
        where: { id: audioId },
        data: {
          filePath: outputPath,
          duration: convertedInfo.duration,
          status: "ready",
        },
      });
    }
  } catch (error) {
    if (error instanceof FfmpegNotInstalledError) {
      console.error(`[Transcribe] FFmpeg not installed: ${error.message}`);
      await prisma.task.update({
        where: { id: taskId },
        data: { status: "failed", error: error.message },
      });
      return;
    }
    throw error;
  }

  await prisma.audioFile.update({
    where: { id: audioId },
    data: { status: "transcribing" },
  });

  // 调用 Whisper 转录
  await prisma.task.update({
    where: { id: taskId },
    data: { progress: 10 },
  });

  console.log(`[Transcribe] Calling Whisper API...`);

  // 确保 Whisper 已初始化
  await ensureWhisperInitialized();

  const audioSeconds = audioFile.duration || 0;
  const CHUNK_DURATION_MS = 300_000; // 5 分钟
  const CHUNK_OVERLAP_MS = 30_000; // 30 秒（whisper encoder 窗口）
  // 短音频（≤ 60s）走单次 transcribe；长音频走 chunked 转录
  const useCheckpoint = audioSeconds > 60;

  let transcriptResult;
  let totalChunks = 0;
  let completedChunksList: number[] = [];
  let actuallyCompletedChunks = 0; // 只在 onChunkDone 真正完成时 +1，避免 force 时被 done.json 误导

  // 把短/长音频两种转录路径都包到一个函数里，便于 GPU 错误重试
  const runTranscriptionOnce = async (runLanguage: string, languageKey: string) => {
    // 重置：本轮（GPU 重试也算新的一轮）从 0 开始计
    actuallyCompletedChunks = 0;

    // ===== force 重跑 = 清空 chunks 状态，让进度从 0 开始 =====
    if (forceTranscribe) {
      const chunksDir = path.join(process.cwd(), "uploads", audioId, "chunks");
      const doneFile = path.join(chunksDir, "done.json");
      const segmentsDir = path.join(chunksDir, "segments");
      try {
        // bilingual-merge 模式下只清当前 languageKey 的产物
        if (languageKey === "zh" || languageKey === "en") {
          const subDir = path.join(segmentsDir, languageKey);
          if (existsSync(subDir)) {
            await rm(subDir, { recursive: true, force: true });
            console.log(`[Transcribe] forceTranscribe=true, reset segments/${languageKey}/`);
          }
        } else {
          if (existsSync(doneFile)) {
            await unlink(doneFile);
          }
          if (existsSync(segmentsDir)) {
            await rm(segmentsDir, { recursive: true, force: true });
            await mkdir(segmentsDir, { recursive: true });
            console.log(`[Transcribe] forceTranscribe=true, reset segments/`);
          }
        }
        completedChunksList = [];
      } catch (e) {
        console.warn(`[Transcribe] failed to reset chunks (continuing):`, e);
      }
    }

    if (!useCheckpoint) {
      console.log(`[Transcribe] Short audio (${audioSeconds}s), using single-shot transcribe`);
      const lastHeartbeatRef = { at: Date.now() };
      return await transcribe(audioPath, {
        language,
        onProgress: async (progress) => {
          lastHeartbeatRef.at = Date.now();
          const taskProgress = Math.min(95, 10 + Math.floor(progress * 0.85));
          try {
            await prisma.task.update({ where: { id: taskId }, data: { progress: taskProgress } });
          } catch (e) {
            console.error(`[Transcribe] progress update failed:`, e);
          }
        },
      });
    }

    // === Chunked transcription with checkpoint ===
    console.log(`[Transcribe] Long audio (${audioSeconds}s), using chunked transcription`);

    const chunksDir = path.join(process.cwd(), "uploads", audioId, "chunks");
    const doneFile = path.join(chunksDir, "done.json");
    const segmentsDir = path.join(chunksDir, "segments");
    if (!existsSync(chunksDir)) {
      await mkdir(chunksDir, { recursive: true });
    }
    if (!existsSync(segmentsDir)) {
      await mkdir(segmentsDir, { recursive: true });
    }

    /**
     * 从 segments/<i>.json 读已持久化的 chunk segments。
     * 返回 null 表示"没缓存"，whisper.ts 会重跑这个 chunk。
     */
    const loadChunkSegments = async (chunkIndex: number, languageKey: string) => {
      const targetDir =
        languageKey === "zh" || languageKey === "en"
          ? path.join(segmentsDir, languageKey)
          : segmentsDir;
      const file = path.join(targetDir, `${chunkIndex}.json`);
      if (!existsSync(file)) return null;
      try {
        const content = await readFile(file, "utf-8");
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) return null;
        return parsed as Array<{ start: number; end: number; text: string }>;
      } catch (e) {
        console.warn(`[Transcribe] failed to read segments/${chunkIndex}.json:`, e);
        return null;
      }
    };

    /**
     * 把单个 chunk 的 segments 写到 segments/<i>.json。
     * 即使 done.json 写成功这个失败也不应该让转录崩——这只是缓存。
     */
    const persistChunkSegments = async (
      chunkIndex: number,
      segs: Array<{ start: number; end: number; text: string }>,
      languageKey: string,
    ) => {
      // bilingual-merge 模式下两遍产物分开存：segments/zh/0.json、segments/en/0.json
      // 单语言模式仍存 segments/0.json（向后兼容）
      const targetDir =
        languageKey === "zh" || languageKey === "en"
          ? path.join(segmentsDir, languageKey)
          : segmentsDir;
      if (!existsSync(targetDir)) {
        await mkdir(targetDir, { recursive: true });
      }
      const file = path.join(targetDir, `${chunkIndex}.json`);
      await writeFile(file, JSON.stringify(segs), "utf-8");
    };

    // 计算总块数
    totalChunks = computeTotalChunks(audioSeconds, CHUNK_DURATION_MS, CHUNK_OVERLAP_MS);
    console.log(`[Transcribe] totalChunks=${totalChunks}`);

    // 读取已完成的 chunk 列表（断点续传）
    if (existsSync(doneFile)) {
      try {
        const doneContent = await readFile(doneFile, "utf-8");
        const parsed = JSON.parse(doneContent);
        completedChunksList = Array.isArray(parsed.completedChunks) ? parsed.completedChunks : [];
        console.log(
          `[Transcribe] Resuming from checkpoint: ${completedChunksList.length} chunks already done`,
        );
      } catch (e) {
        console.warn(`[Transcribe] failed to read done.json, ignoring:`, e);
        completedChunksList = [];
      }
    }

    // 写入/更新 audioFile 的 chunk metadata
    await prisma.audioFile.update({
      where: { id: audioId },
      data: {
        totalChunks,
        completedChunks: actuallyCompletedChunks,
        chunkDurationMs: CHUNK_DURATION_MS,
        chunkOverlapMs: CHUNK_OVERLAP_MS,
      },
    });

    // 心跳：30 秒没新 chunk 完成也写一次 DB
    const lastDbWriteAtRef = { at: Date.now() };
    const heartbeat = setInterval(async () => {
      if (Date.now() - lastDbWriteAtRef.at >= 30_000) {
        try {
          const doneNow = actuallyCompletedChunks; // 不读 done.json，避免 force 时显示 17/17
          const taskProgress = Math.min(
            95,
            10 + Math.floor((doneNow / totalChunks) * 85),
          );
          await prisma.task.update({
            where: { id: taskId },
            data: { progress: taskProgress },
          });
          await prisma.audioFile.update({
            where: { id: audioId },
            data: { completedChunks: doneNow },
          });
          lastDbWriteAtRef.at = Date.now();
        } catch (e) {
          console.error(`[Transcribe] heartbeat update failed:`, e);
        }
      }
    }, 30_000);

    // 每 chunk 自动检测语言：用 detect-language 工具，多采样点 + 投票。
    // 缓存：同一个 startMs 不重复检测。
    const detectedCache = new Map<number, string | null>();
    const languageDetector = async ({ startMs, durationMs }: { startMs: number; durationMs: number }) => {
      if (detectedCache.has(startMs)) {
        return detectedCache.get(startMs) ?? null;
      }
      console.log(
        `[Transcribe] detecting language in chunk starting at ${startMs}ms (${durationMs}ms long)`,
      );
      // 在 chunk 的 10% / 50% / 90% 各采 15 秒，3 个采样点投票
      const detected = await detectLanguage(audioPath, {
        startMs,
        durationMs,
        samplePoints: [0.1, 0.5, 0.9],
        sampleDurationMs: 15_000,
      });
      detectedCache.set(startMs, detected);
      console.log(
        `[Transcribe] detected language for chunk @${startMs}ms: ${detected ?? "(failed, will fallback)"}`,
      );
      return detected;
    };

    const result = await transcribeWithCheckpoint(audioPath, totalChunks, {
      language: runLanguage, // 本遍的固定 language（zh / en / mixed / original）
      languageKey, // cache 文件名隔离 key
      chunkDurationMs: CHUNK_DURATION_MS,
      chunkOverlapMs: CHUNK_OVERLAP_MS,
      alreadyCompletedChunks: completedChunksList,
      loadChunkSegments,
      onChunkSegmentsPersist: persistChunkSegments,
      // 只在 'auto-detect-per-chunk' 模式下触发 detector
      languageDetector: runLanguage === "auto-detect-per-chunk" ? languageDetector : undefined,
      onChunkStart: ({ index, total, startMs, durationMs }) => {
        console.log(
          `[Transcribe] chunk ${index + 1}/${total} starting (startMs=${startMs}, durationMs=${durationMs})`,
        );
      },
      onChunkDone: async ({ index, total, startMs, durationMs, segmentCount }) => {
        // 去重：之前曾出现过重跑场景里同一个 chunk 被 push 多次导致 done.json 膨胀
        if (!completedChunksList.includes(index)) {
          completedChunksList.push(index);
          completedChunksList.sort((a, b) => a - b);
        }
        // 实际完成的 chunk 计数：每次 onChunkDone 真正跑完 +1
        actuallyCompletedChunks++;
        try {
          await writeFile(
            doneFile,
            JSON.stringify({
              version: 1,
              completedChunks: completedChunksList,
              lastUpdated: new Date().toISOString(),
            }),
            "utf-8",
          );
        } catch (e) {
          console.error(`[Transcribe] failed to write done.json:`, e);
        }
        const taskProgress = Math.min(
          95,
          10 + Math.floor((actuallyCompletedChunks / total) * 85),
        );
        console.log(
          `[Transcribe] chunk ${index + 1}/${total} done (${segmentCount} segments), task progress=${taskProgress}%`,
        );
        try {
          await prisma.task.update({
            where: { id: taskId },
            data: { progress: taskProgress },
          });
          await prisma.audioFile.update({
            where: { id: audioId },
            data: { completedChunks: actuallyCompletedChunks },
          });
          lastDbWriteAtRef.at = Date.now();
        } catch (e) {
          console.error(`[Transcribe] chunk-done DB update failed:`, e);
        }
      },
    });

    clearInterval(heartbeat);
    return result;
  };

  // ===== bilingual-merge 模式：串行跑 zh + en 两遍，LLM 合并 =====
  if (language === "bilingual-merge") {
    console.log(`[Transcribe] Bilingual merge mode: running zh then en`);

    // force 时清掉之前的双语产物（zh + en 子目录 + done.json + 合并结果 + raw.txt/raw_zh/raw_en）
    if (forceTranscribe) {
      const chunksDir = path.join(process.cwd(), "uploads", audioId, "chunks");
      const uploadDirForClean = path.join(process.cwd(), "uploads", audioId);
      try {
        for (const sub of ["zh", "en"]) {
          const subDir = path.join(chunksDir, "segments", sub);
          if (existsSync(subDir)) {
            await rm(subDir, { recursive: true, force: true });
          }
        }
        const doneFile = path.join(chunksDir, "done.json");
        if (existsSync(doneFile)) await unlink(doneFile);
        // 清合并产物（raw.txt 等）
        for (const name of ["raw.txt", "raw_zh.txt", "raw_en.txt"]) {
          const f = path.join(uploadDirForClean, name);
          if (existsSync(f)) await unlink(f);
        }
      } catch (e) {
        console.warn(`[Transcribe] failed to clean bilingual state:`, e);
      }
    }

    // 第 1 遍：zh
    await prisma.task.update({
      where: { id: taskId },
      data: { progress: 15 },
    });
    console.log(`[Transcribe] === bilingual pass 1/3: zh ===`);
    const zhResult = await runTranscriptionOnce("zh", "zh");

    // 落盘 zh 版 raw.txt（保留中间产物，方便调试或重跑合并）
    const uploadDir = path.join(process.cwd(), "uploads", audioId);
    const rawZhPath = path.join(uploadDir, "raw_zh.txt");
    await writeFile(rawZhPath, zhResult.fullText, "utf-8");
    console.log(`[Transcribe] zh pass done, saved to ${rawZhPath} (${zhResult.fullText.length} chars)`);

    // 第 2 遍：en
    await prisma.task.update({
      where: { id: taskId },
      data: { progress: 50 },
    });
    console.log(`[Transcribe] === bilingual pass 2/3: en ===`);
    const enResult = await runTranscriptionOnce("en", "en");

    const rawEnPath = path.join(uploadDir, "raw_en.txt");
    await writeFile(rawEnPath, enResult.fullText, "utf-8");
    console.log(`[Transcribe] en pass done, saved to ${rawEnPath} (${enResult.fullText.length} chars)`);

    // 第 3 步：LLM 合并（断点：如果 raw.txt 已存在就跳过 LLM 调用）
    const rawMergedPath = path.join(uploadDir, "raw.txt");
    let mergedText: string;
    if (existsSync(rawMergedPath) && !forceTranscribe) {
      // raw.txt 已存在 + 非 force 模式 → 直接用之前合并的结果（断点续传）
      const { readFile } = await import("fs/promises");
      mergedText = (await readFile(rawMergedPath, "utf-8")).trim();
      console.log(
        `[Transcribe] === bilingual pass 3/3: using cached raw.txt (${mergedText.length} chars), skip LLM ===`,
      );
    } else {
      await prisma.task.update({
        where: { id: taskId },
        data: { progress: 90 },
      });
      console.log(`[Transcribe] === bilingual pass 3/3: LLM merge ===`);
      mergedText = await mergeBilingualTranscripts({
        audioPath: uploadDir,
        rawZh: zhResult.fullText,
        rawEn: enResult.fullText,
        apiKey: process.env.ARK_PLAN_API_KEY || process.env.ARK_API_KEY,
        baseURL: process.env.ARK_API_BASE || "https://ark.cn-beijing.volces.com/api/coding/v3",
        model: process.env.ARK_MODEL || "deepseek-v4-1-flash-260910",
      });
      console.log(
        `[Transcribe] merge done, ${mergedText.length} chars`,
      );
    }

    // 写 raw.txt + Transcript（直接进保存分支）
    transcriptResult = {
      language: "zh+en",
      fullText: mergedText,
      segments: zhResult.segments, // 用 zh 的 segments（时间戳对齐），不强求 merge
    };
    // 跳到下面的保存分支
  } else {
  try {
    transcriptResult = await runTranscriptionOnce(language, language);
  } catch (err: unknown) {
    const e = err as Error & { oomRecoverable?: boolean; gpuRecovered?: boolean };
    if (!e.oomRecoverable) throw err;

    // GPU 显存或驱动出问题：杀残留 + 重置 NVIDIA PnP 驱动 + 等驱动回来
    console.warn(
      `[Transcribe] Detected GPU/oom error, recovering: ${e.message.slice(0, 200)}`,
    );
    const recovery = await recoverGpuMemory();
    console.log(
      `[Transcribe] GPU recovery: killed=${recovery.killed}, reset=${recovery.reset}`,
    );
    // 给驱动初始化再留点 buffer
    await new Promise((r) => setTimeout(r, 2000));

    // 重置 GPU 后重试 1 次
    try {
      transcriptResult = await runTranscriptionOnce(language, language);
      console.log(`[Transcribe] Retry after GPU reset succeeded`);
    } catch (retryErr) {
      // 重试还失败，附"已重置"信息让前端展示
      const e2 = retryErr as Error;
      e2.message = `[已重置 NVIDIA 驱动] ${e2.message}`;
      throw e2;
    }
  }
  }  // 关闭 else (language !== 'bilingual-merge')

  console.log(`[Transcribe] Whisper completed, text length: ${transcriptResult.fullText.length}`);

  // 转录完成后保存 transcript，并把 task 推到 waiting_for_prompt
  await prisma.task.update({
    where: { id: taskId },
    data: { progress: 98 },
  });

  await prisma.transcript.upsert({
    where: { audioFileId: audioId },
    create: {
      audioFileId: audioId,
      language: transcriptResult.language,
      fullText: transcriptResult.fullText,
      segments: JSON.stringify(transcriptResult.segments),
      status: "completed",
    },
    update: {
      language: transcriptResult.language,
      fullText: transcriptResult.fullText,
      segments: JSON.stringify(transcriptResult.segments),
      status: "completed",
    },
  });

  const uploadDir = path.join(process.cwd(), "uploads", audioId);
  const rawTextPath = path.join(uploadDir, "raw.txt");
  await writeFile(rawTextPath, transcriptResult.fullText, "utf-8");
  console.log(`[Transcribe] Raw transcript saved to: ${rawTextPath}`);

  await prisma.audioFile.update({
    where: { id: audioId },
    data: { status: "completed" },
  });

  // 断点：转录完成，等待用户审核 / 修改 system prompt，再触发出生成步骤。
  // 后续文章生成由 POST /api/generate 完成。
  await prisma.task.update({
    where: { id: taskId },
    data: { progress: 100, status: "waiting_for_prompt" },
  });
  console.log(`[Transcribe] Task ${taskId} paused, waiting for prompt confirmation`);
}
