import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ARTICLE_SYSTEM_PROMPT } from "@/lib/openai-compatible";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;

    const task = await prisma.task.findUnique({ where: { id: taskId } });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    let audioStatus = null;
    let transcriptId: string | null = null;
    let transcriptPreview: string | null = null;
    let transcriptLength = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let audioFile: any = null;

    if (task.audioId) {
      audioFile = await prisma.audioFile.findUnique({
        where: { id: task.audioId },
        include: { transcript: true },
      });
      if (audioFile) {
        audioStatus = audioFile.status;
        if (audioFile.transcript) {
          transcriptId = audioFile.transcript.id;
          transcriptLength = audioFile.transcript.fullText.length;
          // 200 字预览，前端不需要整段
          transcriptPreview = audioFile.transcript.fullText.slice(0, 200);
        }
      }
    }

    return NextResponse.json({
      status: task.status === "processing" ? "processing" : task.status,
      progress: task.progress,
      audioStatus: audioStatus,
      transcriptId,
      transcriptLength,
      transcriptPreview,
      defaultPrompt: ARTICLE_SYSTEM_PROMPT,
      customPrompt: task.customPrompt,
      result: task.result ? JSON.parse(task.result) : null,
      error: task.error,
      // 断点续转进度（短音频这些字段为 null）
      totalChunks: audioFile?.totalChunks ?? null,
      completedChunks: audioFile?.completedChunks ?? null,
      chunkDurationMs: audioFile?.chunkDurationMs ?? null,
      chunkOverlapMs: audioFile?.chunkOverlapMs ?? null,
    });
  } catch (error) {
    console.error("Task query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
