import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { transcribe, init as initWhisper } from "@/lib/whisper";
import path from "path";
import { writeFile } from "fs/promises";
import { convertToWav, getAudioInfo, isFfmpegInstalled, FfmpegNotInstalledError } from "@/lib/audio-converter";

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
    const { audioId, forceTranscribe } = body as { audioId?: string; forceTranscribe?: boolean };

    if (!audioId) {
      return NextResponse.json({ error: "audioId required" }, { status: 400 });
    }

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
      `[Transcribe] Created task ${task.id}, audioId: ${audioId}, forceTranscribe=${!!forceTranscribe}`,
    );
    processTranscribe(task.id, audioId, !!forceTranscribe).catch((err) => {
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

  // 进度映射：转录 10% → 95%（留 5% 给后处理保存 transcript）。
  // whisper 自己的进度 0–100% 会被映射到这个区间。
  const transcriptResult = await transcribe(audioPath, {
    language: 'zh',
    onProgress: async (progress) => {
      console.log(`[Transcribe] Whisper progress: ${progress}%`);
      // 10 + progress * 0.85 → 转录时进度从 10% 爬到 95%
      const taskProgress = Math.min(95, 10 + Math.floor(progress * 0.85));
      console.log(`[Transcribe] Updating task progress to ${taskProgress}%`);
      try {
        await prisma.task.update({
          where: { id: taskId },
          data: { progress: taskProgress },
        });
      } catch (e) {
        // DB 写失败不能让转录崩掉，只打印
        console.error(`[Transcribe] progress update failed:`, e);
      }
    },
  });

  console.log(`[Transcribe] Whisper completed, text length: ${transcriptResult.fullText.length}`);

  // 转录完成后保存 transcript，并把 task 推到 waiting_for_prompt
  await prisma.task.update({
    where: { id: taskId },
    data: { progress: 98 },
  });

  await prisma.transcript.create({
    data: {
      audioFileId: audioId,
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
