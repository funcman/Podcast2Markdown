import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/whisper";
import { generateArticle } from "@/lib/minimax";

export const runtime = "nodejs";

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

  // 获取音频文件
  const audioFile = await prisma.audioFile.findUnique({ where: { id: audioId } });
  if (!audioFile) {
    console.error(`[Transcribe] Audio file ${audioId} not found`);
    throw new Error("Audio file not found");
  }

  console.log(`[Transcribe] Found audio file: ${audioFile.fileName}, size: ${audioFile.fileSize}, path: ${audioFile.filePath}`);

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

  const transcriptResult = await transcribeAudio(audioFile.filePath);

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
