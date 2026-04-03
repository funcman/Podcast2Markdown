import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ audioId: string }> }
) {
  try {
    const { audioId } = await params;

    const audioFile = await prisma.audioFile.findUnique({
      where: { id: audioId },
    });

    if (!audioFile) {
      return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
    }

    return NextResponse.json({
      status: audioFile.status,
      fileName: audioFile.fileName,
      fileSize: audioFile.fileSize,
      duration: audioFile.duration,
      format: audioFile.format,
    });
  } catch (error) {
    console.error("Audio query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}