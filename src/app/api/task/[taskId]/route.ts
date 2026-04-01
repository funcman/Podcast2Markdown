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

    return NextResponse.json({
      status: task.status === "processing" ? "processing" : task.status,
      progress: task.progress,
      result: task.result ? JSON.parse(task.result) : null,
      error: task.error,
    });
  } catch (error) {
    console.error("Task query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
