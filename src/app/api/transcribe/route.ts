import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { transcribe, init as initWhisper } from "@/lib/whisper";
import { generateArticle } from "@/lib/minimax";
import path from "path";
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
    const { audioId } = await request.json();

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
    console.log(`[Transcribe] Created task ${task.id}, audioId: ${audioId}`);
    processTranscribe(task.id, audioId).catch((err) => {
      console.error(`[Transcribe] Task ${task.id} failed:`, err.message);
      prisma.task.update({
        where: { id: task.id },
        data: { status: "failed", error: err.message },
      });
    });

    return NextResponse.json({ taskId: task.id });
  } catch (error) {
    console.error("Transcribe error:", error);
    return NextResponse.json({ error: "Transcribe failed" }, { status: 500 });
  }
}

async function processTranscribe(taskId: string, audioId: string) {
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

  console.log(`[Transcribe] Found audio file: ${audioFile.fileName}, size: ${audioFile.fileSize}, path: ${audioFile.filePath}`);

  // 检查音频格式，决定是否需要转换
  let audioPath = audioFile.filePath;
  const sourcePath = audioFile.originalPath || audioFile.filePath;
  
  try {
    const audioInfo = await getAudioInfo(sourcePath);
    console.log(`[Transcribe] Audio format: ${audioInfo.format}, duration: ${audioInfo.duration}s`);

    if (audioInfo.format.toLowerCase() === "wav") {
      // WAV 格式直接使用原始文件
      console.log(`[Transcribe] WAV format detected, skipping conversion`);
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
    data: { progress: 30 },
  });

  console.log(`[Transcribe] Calling Whisper API...`);

  // 确保 Whisper 已初始化
  await ensureWhisperInitialized();

  const transcriptResult = await transcribe(audioPath);

  console.log(`[Transcribe] Whisper completed, text length: ${transcriptResult.fullText.length}`);

  await prisma.task.update({
    where: { id: taskId },
    data: { progress: 60 },
  });

  // 保存转录结果
  const transcript = await prisma.transcript.create({
    data: {
      audioFileId: audioId,
      language: transcriptResult.language,
      fullText: transcriptResult.fullText,
      segments: JSON.stringify(transcriptResult.segments),
      status: "completed",
    },
  });

  await prisma.audioFile.update({
    where: { id: audioId },
    data: { status: "completed" },
  });

  await prisma.task.update({
    where: { id: taskId },
    data: { progress: 80 },
  });

  // 调用 Minimax 生成文章
  console.log(`[Transcribe] Calling Minimax API...`);
  const articleResult = await generateArticle(transcriptResult.fullText);

  // 保存文章
  const article = await prisma.article.create({
    data: {
      transcriptId: transcript.id,
      title: articleResult.title,
      content: articleResult.content,
      summary: articleResult.summary,
      tags: JSON.stringify(articleResult.tags),
      highlights: JSON.stringify(articleResult.highlights),
    },
  });

  console.log(`[Transcribe] Article created: ${article.title}`);

  // 完成任务 - 把完整结果放进去
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: "completed",
      progress: 100,
      result: JSON.stringify({
        article: {
          id: article.id,
          title: article.title,
          content: article.content,
        },
        extracted: {
          tags: articleResult.tags,
          highlights: articleResult.highlights,
          summary: articleResult.summary,
        },
      }),
    },
  });
}
