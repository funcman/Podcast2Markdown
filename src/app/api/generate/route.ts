import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateArticle } from "@/lib/minimax";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { transcriptId } = await request.json();

    if (!transcriptId) {
      return NextResponse.json({ error: "transcriptId required" }, { status: 400 });
    }

    const transcript = await prisma.transcript.findUnique({
      where: { id: transcriptId },
      include: { article: true },
    });

    if (!transcript) {
      return NextResponse.json({ error: "Transcript not found" }, { status: 404 });
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

    const articleResult = await generateArticle(transcript.fullText);

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
    return NextResponse.json({ error: "Generate failed" }, { status: 500 });
  }
}
