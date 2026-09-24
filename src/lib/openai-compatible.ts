/**
 * 共享的 OpenAI 兼容 Chat Completions 调用层。
 *
 * Minimax 与火山引擎方舟 Coding Plan 都提供 OpenAI 兼容的
 * `POST {baseURL}/chat/completions` 接口，因此流式读取、进度上报、
 * JSON 解析等逻辑统一放在这里，各 provider 只负责提供配置。
 */

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

export interface GenerateOptions {
  onProgress?: (progress: number) => void;
  /** 自定义 system prompt；不传则用默认 ARTICLE_SYSTEM_PROMPT */
  systemPrompt?: string;
}

export interface ChatProvider {
  /** 内部标识，如 "minimax" / "ark" */
  id: string;
  /** 日志与错误信息中展示的名称 */
  label: string;
  apiKey: string | undefined;
  baseURL: string;
  model: string;
  /**
   * 进度估算系数：假设输出长度 ≈ 转录文本长度 × 该系数。
   * 不同模型输出长度差异较大，可按 provider 调整。
   */
  progressRatio?: number;
}

export const ARTICLE_SYSTEM_PROMPT = `你是一个播客文字整理助手。请将以下转录文本整理成结构化Markdown文章。

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

const DEFAULT_PROGRESS_RATIO = 0.25;

/**
 * 调用 OpenAI 兼容接口生成文章。
 * 逐块读取 SSE 流，把增量内容拼接后解析为结构化 JSON。
 */
export async function generateArticleWithProvider(
  provider: ChatProvider,
  transcript: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const { onProgress, systemPrompt } = options;
  const { id, label, apiKey, baseURL, model } = provider;
  const progressRatio = provider.progressRatio ?? DEFAULT_PROGRESS_RATIO;

  if (!apiKey) {
    throw new Error(
      `${label} API key is not configured (provider: ${id}). Please set it in .env`
    );
  }

  // 允许 ARK_API_BASE / MINIMAX_API_BASE 直接写成完整 endpoint
  const normalizedBase = baseURL
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
  const url = `${normalizedBase}/chat/completions`;
  console.log(
    `[${label}] Starting generation, model: ${model}, transcript length: ${transcript.length}`
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt?.trim() || ARTICLE_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      stream: true,
    }),
  });

  console.log(`[${label}] Response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[${label}] API error: ${response.status} - ${errorText}`);
    throw new Error(`${label} API error: ${response.status} - ${errorText}`);
  }

  if (!response.body) {
    throw new Error(`${label} response body is null`);
  }

  const fullContent = await readStream(response.body, {
    label,
    estimatedTotal: Math.max(1, transcript.length * progressRatio),
    onProgress,
  });

  console.log(`[${label}] Stream completed, total length: ${fullContent.length}`);

  if (!fullContent.trim()) {
    throw new Error(`${label} returned empty content`);
  }

  const parsed = parseArticleJson(fullContent, label);
  console.log(`[${label}] Parsed article JSON successfully`);
  return parsed;
}

interface ReadStreamOptions {
  label: string;
  estimatedTotal: number;
  onProgress?: (progress: number) => void;
}

/** 读取 SSE 流并拼接 delta.content；按行缓冲，避免 JSON 被分块截断。 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  { label, estimatedTotal, onProgress }: ReadStreamOptions
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let lastProgress = 0;
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 只处理完整行，最后一段可能是被截断的半行，留到下一轮
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;

      const dataStr = line.slice("data:".length).trim();
      if (dataStr === "[DONE]") {
        finished = true;
        break;
      }

      try {
        const data = JSON.parse(dataStr);
        const delta: unknown = data?.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || delta === "") continue;

        fullContent += delta;
        const progress = Math.min(
          95,
          Math.floor((fullContent.length / estimatedTotal) * 100)
        );
        if (progress > lastProgress && onProgress) {
          lastProgress = progress;
          onProgress(progress);
        }
      } catch {
        // 忽略无法解析的行（keep-alive、usage 等）
      }
    }
  }

  if (buffer.trim().startsWith("data:")) {
    // 流结束时可能残留最后一行（无换行收尾）
    const dataStr = buffer.trim().slice("data:".length).trim();
    if (dataStr && dataStr !== "[DONE]") {
      try {
        const data = JSON.parse(dataStr);
        const delta: unknown = data?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") fullContent += delta;
      } catch {
        // ignore
      }
    }
  }

  console.log(`[${label}] Stream reading finished`);
  return fullContent;
}

/** 从模型输出中提取 JSON（兼容 ```json 代码块包裹的情况）并做字段兜底。 */
export function parseArticleJson(raw: string, label: string): GenerateResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${label} response is not JSON: ${raw.slice(0, 200)}`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `${label} response JSON parse failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return normalizeArticle(parsed);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeArticle(parsed: Record<string, unknown>): GenerateResult {
  const highlights: Highlight[] = Array.isArray(parsed.highlights)
    ? parsed.highlights
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          text: asString(item.text),
          context: asString(item.context),
        }))
        .filter((item) => item.text !== "")
    : [];

  return {
    title: asString(parsed.title).trim() || "未命名文章",
    outline: asStringArray(parsed.outline),
    content: asString(parsed.content),
    tags: asStringArray(parsed.tags),
    highlights,
    summary: asString(parsed.summary),
  };
}
