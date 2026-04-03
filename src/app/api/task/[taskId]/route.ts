import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
    if (task.audioId) {
      const audioFile = await prisma.audioFile.findUnique({
        where: { id: task.audioId },
      });
      if (audioFile) {
        audioStatus = audioFile.status;
      }
    }

    return NextResponse.json({
      status: task.status === "processing" ? "processing" : task.status,
      progress: task.progress,
      audioStatus: audioStatus,
      result: task.result ? JSON.parse(task.result) : null,
      error: task.error,
    });
  } catch (error) {
    console.error("Task query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
