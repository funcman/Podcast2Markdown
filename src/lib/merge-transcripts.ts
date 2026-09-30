/**
 * merge-transcripts.ts
 *
 * 用 LLM 合并两个转录产物（强制 zh 版 + 强制 en 版）：
 *   - zh 版：中文段准确，英文段被强转中文
 *   - en 版：英文段准确，中文段被强翻成英文
 *   - 合并：每段时间挑真实语言版本，输出混合文本
 *
 * 用于中英混杂音频（zh + en 双语转录 + LLM 后处理）。
 */

export interface MergeOptions {
  audioPath: string;                  // 音频路径（写到 prompt 让 LLM 知道上下文）
  rawZh: string;                       // 强制 zh 转录产物
  rawEn: string;                       // 强制 en 转录产物
  apiKey: string | undefined;
  baseURL: string;
  model: string;
}

/**
 * 调用 OpenAI 兼容 chat completion API（非流式），返回合并文本。
 */
export async function mergeBilingualTranscripts(
  options: MergeOptions
): Promise<string> {
  const { audioPath, rawZh, rawEn, apiKey, baseURL, model } = options;

  if (!apiKey) {
    throw new Error(
      "mergeBilingualTranscripts: apiKey is required (set ARK_PLAN_API_KEY in .env)"
    );
  }

  const systemPrompt = `你是播客转录合并助手。
我会给你同一段音频的两份转录稿：
- raw_zh 是强制按中文转录的版本。中文段准确，但英文段被强转中文（错译）。
- raw_en 是强制按英文转录的版本。英文段准确，但中文段被强翻成英文（错译）。

任务：
1. 对照两份稿子，逐段判断真实语言。
2. 中文段 → 优先采用 raw_zh 的文本（更准）
3. 英文段 → 优先采用 raw_en 的文本（更准）
4. 不要翻译、不要改写、不要总结，只选更准的版本
5. 保持原始段落顺序，不要重新组织
6. 输出纯合并文本，不要任何前缀/标题/JSON

如果两份稿子都有错译（中英混杂段落），选择更通顺、信息更完整的版本。`;

  const userPrompt = `音频路径: ${audioPath}

=== raw_zh.txt (强制中文模式转录) ===
${rawZh}

=== raw_en.txt (强制英文模式转录) ===
${rawEn}

请输出合并后的文本：`;

  const endpoint = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 8000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `mergeBilingualTranscripts: API ${response.status} - ${errorText.slice(0, 500)}`
    );
  }

  const data = await response.json();
  const merged = data?.choices?.[0]?.message?.content;
  if (typeof merged !== "string" || merged.length === 0) {
    throw new Error("mergeBilingualTranscripts: empty response from LLM");
  }
  return merged.trim();
}