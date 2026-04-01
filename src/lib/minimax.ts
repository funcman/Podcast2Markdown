const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_API_BASE = process.env.MINIMAX_API_BASE || "https://api.minimaxi.com/v1";

export interface Highlight {
  text: string;
  context: string;
}

export interface GenerateResult {
  title: string;
  outline: string[];
  content: string;
  tags: string[];
  highlights: Highlight[];
  summary: string;
}

const SYSTEM_PROMPT = `你是一个播客文字整理助手。请将以下转录文本整理成结构化Markdown文章。

要求：
1. 生成一个简洁准确的标题
2. 生成目录（## 大纲），包含2-5个主要章节
3. 按逻辑章节组织内容，每个章节用 ### 标记
4. 保留关键引述和金句，用 > 引用样式
5. 生成5-10个主题标签
6. 提取3-5个高亮金句（观点鲜明，50字以内）
7. 生成200字以内的摘要

输出格式（JSON）：
{
  "title": "标题",
  "outline": ["章节1", "章节2"],
  "content": "完整Markdown内容",
  "tags": ["标签1", "标签2"],
  "highlights": [{"text": "金句", "context": "上下文"}],
  "summary": "摘要"
}`;

export async function generateArticle(transcript: string): Promise<GenerateResult> {
  console.log(`[Minimax] Starting generation, transcript length: ${transcript.length}`);

  const requestBody = {
    model: "MiniMax-M2.7",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ],
  };

  console.log(`[Minimax] Request body prepared, calling API...`);

  const response = await fetch(`${MINIMAX_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  console.log(`[Minimax] Response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Minimax] API error: ${response.status} - ${errorText}`);
    throw new Error(`Minimax API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  console.log(`[Minimax] Response data:`, JSON.stringify(data).slice(0, 500));

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Minimax returned empty content");
  }

  // 解析 JSON 响应
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse Minimax response as JSON");
  }

  console.log(`[Minimax] Parsed JSON successfully`);

  return JSON.parse(jsonMatch[0]) as GenerateResult;
}
