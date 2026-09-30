import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { sha256File } from "@/lib/content-hash";

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

    // 流式计算 SHA-256，用于跨任务复用 Transcript。
    // 137 MB 音频在现代 CPU 上 200-500 ms 算完，不阻塞主流程太多。
    let contentHash: string | null = null;
    try {
      const t0 = Date.now();
      contentHash = await sha256File(originalPath);
      console.log(
        `[Upload] SHA-256 ${contentHash.slice(0, 12)}... in ${Date.now() - t0}ms`
      );
    } catch (e) {
      console.error("[Upload] hash failed:", e);
      // hash 失败不影响上传，只是不参与复用逻辑
    }

    // ===== 查同 hash 的历史记录，给前端"是否复用"的信号 =====
    let existingCompleted: { audioId: string; taskId: string } | null = null;
    let existingIncomplete: {
      audioId: string;
      taskId: string;
      status: string;
      progress: number;
      completedChunks: number | null;
      totalChunks: number | null;
    } | null = null;

    if (contentHash) {
      const candidates = await prisma.audioFile.findMany({
        where: { contentHash, id: { not: audioId } },
        include: { transcript: true },
        orderBy: { createdAt: "asc" },
      });
      for (const cand of candidates) {
        // 找最近的一条 completed transcript
        if (cand.transcript?.status === "completed") {
          // 找对应的 task（用 taskId 反查）
          const t = await prisma.task.findFirst({
            where: { audioId: cand.id },
            orderBy: { createdAt: "desc" },
          });
          if (t) {
            existingCompleted = { audioId: cand.id, taskId: t.id };
          }
          break;
        }
      }
      // 找最近的未完成 task（status 不是 completed/failed）
      const incompleteTask = await prisma.task.findFirst({
        where: {
          audioId: { in: candidates.map((c) => c.id) },
          status: { notIn: ["completed", "failed"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (incompleteTask) {
        const af = await prisma.audioFile.findUnique({
          where: { id: incompleteTask.audioId! },
        });
        if (af) {
          existingIncomplete = {
            audioId: incompleteTask.audioId!,
            taskId: incompleteTask.id,
            status: incompleteTask.status,
            progress: incompleteTask.progress,
            completedChunks: af.completedChunks,
            totalChunks: af.totalChunks,
          };
        }
      }
    }

    // 如果有未完成 task，前端会走"直接处理/重新处理"分支；
    // 这种情况下：
    //   1. **不创建** 新的 audioFile（旧的 audioFile 记录 + 旧文件已经存在）
    //   2. **删除** 刚上传到新 audioId 目录的文件，避免磁盘空间浪费
    //   3. 返回**旧** audioId，前端用旧 ID 走后续流程
    if (existingIncomplete) {
      console.log(
        `[Upload] Found incomplete task ${existingIncomplete.taskId} for hash ${contentHash?.slice(0, 12)}, reusing audioId=${existingIncomplete.audioId}`,
      );
      // 清理刚上传的文件和空目录
      try {
        await rm(uploadDir, { recursive: true, force: true });
        console.log(`[Upload] Cleaned up ${uploadDir}`);
      } catch (e) {
        console.warn(`[Upload] failed to cleanup ${uploadDir}:`, e);
      }
      return NextResponse.json({
        audioId: existingIncomplete.audioId, // 关键：返回旧的 audioId，不是新上传的
        fileName: file.name,
        duration: null,
        status: "pending",
        contentHash,
        // 关键信号
        hasIncompleteTask: true,
        incompleteTask: existingIncomplete,
        hasCompletedTranscript: false,
      });
    }

    if (existingCompleted) {
      console.log(
        `[Upload] Found completed transcript for hash ${contentHash?.slice(0, 12)}`,
      );
      // 仍然创建当前 audioFile 记录（保留历史），但前端会直接走复用分支
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
          contentHash,
        },
      });
      return NextResponse.json({
        audioId: audioFile.id,
        fileName: audioFile.fileName,
        duration: audioFile.duration,
        status: audioFile.status,
        contentHash,
        hasCompletedTranscript: true,
        completedTranscriptRef: existingCompleted,
        hasIncompleteTask: false,
      });
    }

    console.log("[Upload] Creating database record...");
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
        contentHash,
      },
    });
    console.log(`[Upload] Database record created: ${audioFile.id}`);

    return NextResponse.json({
      audioId: audioFile.id,
      fileName: audioFile.fileName,
      duration: audioFile.duration,
      status: audioFile.status,
      contentHash,
      hasIncompleteTask: false,
      hasCompletedTranscript: false,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}