import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const article = await prisma.article.findUnique({ where: { id } });

    if (!article) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    let tags: string[] = [];
    try {
      tags = article.tags ? JSON.parse(article.tags) : [];
    } catch (e) {
      console.error('[Export] Failed to parse tags:', e);
    }

    const markdown = `${article.content}

---

**Tags**: ${tags.join(", ")}
${article.summary ? `\n**摘要**: ${article.summary}` : ""}
`;

    // RFC 5987 编码
    const encodeRFC5987 = (str: string) => {
      return encodeURIComponent(str)
        .replace(/['()]/g, escape)
        .replace(/\*/g, '%2A')
        .replace(/%20/g, '_');
    };

    // 编码后截断到 255 字节（各 OS 文件名极限），留 3 字节给 ".md"
    const MAX_BYTES = 255 - 3;
    let encoded = encodeRFC5987(article.title) + '.md';

    if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) {
      // 二分查找最大可截取位置
      let lo = 0, hi = article.title.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const test = encodeRFC5987(article.title.slice(0, mid)) + '.md';
        if (Buffer.byteLength(test, 'utf8') <= MAX_BYTES) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      encoded = encodeRFC5987(article.title.slice(0, lo)) + '.md';
    }

    return new NextResponse(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encoded}"`,
      },
    });
  } catch (error) {
    console.error("[Export] Error:", error);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
