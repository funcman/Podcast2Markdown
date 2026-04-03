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
    const originalFileName = `original${ext}`;
    const originalPath = path.join(uploadDir, originalFileName);
    await writeFile(originalPath, buffer);

    const audioFile = await prisma.audioFile.create({
      data: {
        id: audioId,
        fileName: file.name,
        fileSize: buffer.length,
        duration: null,
        format: ext.slice(1),
        originalPath,
        filePath: "",
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
