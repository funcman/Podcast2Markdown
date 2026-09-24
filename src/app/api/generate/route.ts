import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateArticle } from "@/lib/providers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { transcriptId, taskId, customPrompt } = body;

    if (!transcriptId) {
      return NextResponse.json({ error: "transcriptId required" }, { status: 400 });
    }

    const transcript = await prisma.transcript.findUnique({
      where: { id: transcriptId },
      include: { article: true, audioFile: true },
    });

    if (!transcript) {
      return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
    }

    // 如果传了 taskId，把用户编辑后的 customPrompt 落库（便于审计/回看）
    if (taskId && customPrompt !== undefined) {
      await prisma.task.update({
        where: { id: taskId },
        data: { customPrompt: customPrompt || null },
      });
    }

    // 如果文章已存在，直接返回
    if (transcript.article) {
      return NextResponse.json({
        article: {
          id: transcript.article.id,
          title: transcript.article.title,
          content: transcript.article.content,
        },
        extracted: {
          tags: JSON.parse(transcript.article.tags || "[]"),
          highlights: JSON.parse(transcript.article.highlights || "[]"),
          summary: transcript.article.summary,
        },
      });
    }

    // 如果传了 taskId，把 task 切到 generating 状态，让前端继续轮询进度
    if (taskId) {
      await prisma.task.update({
        where: { id: taskId },
        data: { status: "generating", progress: 75 },
      });
    }

    const articleResult = await generateArticle(transcript.fullText, {
      systemPrompt: customPrompt,
      onProgress: taskId
        ? async (progress) => {
            const taskProgress = 75 + Math.floor(progress * 0.25);
            await prisma.task.update({
              where: { id: taskId },
              data: { progress: taskProgress },
            });
          }
        : undefined,
    });

    const article = await prisma.article.create({
      data: {
        transcriptId,
        title: articleResult.title,
        content: articleResult.content,
        summary: articleResult.summary,
        tags: JSON.stringify(articleResult.tags),
        highlights: JSON.stringify(articleResult.highlights),
      },
    });

    if (taskId) {
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
            transcript: {
              fullText: transcript.fullText,
            },
          }),
        },
      });
    }

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error("Generate error:", error);
    const { taskId } = await request.clone().json().catch(() => ({}));
    if (taskId) {
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {});
    }
    return NextResponse.json({ error: "Generate failed" }, { status: 500 });
  }
}
