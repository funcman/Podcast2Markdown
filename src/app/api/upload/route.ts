import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 1024 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    console.log("[Upload] Starting upload request");
    
    const formData = await request.formData();
    console.log("[Upload] FormData received");
    
    const file = formData.get("file") as File | null;

    if (!file) {
      console.log("[Upload] No file provided");
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    console.log(`[Upload] File received: ${file.name}, size: ${file.size} bytes`);

    if (file.size > MAX_FILE_SIZE) {
      console.log(`[Upload] File too large: ${file.size} > ${MAX_FILE_SIZE}`);
      return NextResponse.json(
        { error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` },
        { status: 400 }
      );
    }

    const audioId = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const uploadDir = path.join(process.cwd(), "uploads", audioId);
    console.log(`[Upload] Creating directory: ${uploadDir}`);

    if (!existsSync(uploadDir)) {
      await mkdir(uploadDir, { recursive: true });
    }

    console.log(`[Upload] Reading file buffer...`);
    const buffer = Buffer.from(await file.arrayBuffer());
    console.log(`[Upload] Buffer read: ${buffer.length} bytes`);
    
    const ext = path.extname(file.name) || ".mp3";
    const originalFileName = `original${ext}`;
    const originalPath = path.join(uploadDir, originalFileName);
    
    console.log(`[Upload] Writing file to: ${originalPath}`);
    await writeFile(originalPath, buffer);
    console.log(`[Upload] File written successfully`);

    console.log(`[Upload] Creating database record...`);
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
    console.log(`[Upload] Database record created: ${audioFile.id}`);

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
