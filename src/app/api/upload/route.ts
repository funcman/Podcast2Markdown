import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const audioId = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const uploadDir = path.join(process.cwd(), "uploads", audioId);

    if (!existsSync(uploadDir)) {
      await mkdir(uploadDir, { recursive: true });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = path.extname(file.name) || ".mp3";
    const filePath = path.join(uploadDir, `audio${ext}`);
    await writeFile(filePath, buffer);

    // 估算时长（实际需要 ffprobe，这里用文件大小估算）
    const estimatedDuration = Math.floor(buffer.length / (128 * 1024 / 8)); // 按 128kbps 估算

    const audioFile = await prisma.audioFile.create({
      data: {
        id: audioId,
        fileName: file.name,
        fileSize: buffer.length,
        duration: estimatedDuration,
        format: ext.slice(1),
        filePath,
        status: "pending",
      },
    });

    return NextResponse.json({
      audioId: audioFile.id,
      fileName: audioFile.fileName,
      duration: audioFile.duration,
      status: audioFile.status,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
