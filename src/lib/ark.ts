/**
 * 火山引擎方舟（Volcano Ark）Coding Plan provider。
 *
 * Coding Plan 提供 OpenAI 兼容接口，Base URL 形如：
 *   https://ark.cn-beijing.volces.com/api/coding/v3
 * 调用方式与 Minimax 一致（POST {baseURL}/chat/completions，Bearer 鉴权），
 * 因此复用 src/lib/openai-compatible.ts 的流式实现。
 *
 * 环境变量：
 *   ARK_PLAN_API_KEY  Coding Plan 专属 API Key（优先；与 DSH 中的命名保持一致）
 *   ARK_API_KEY       方舟通用 API Key（备选）
 *   ARK_API_BASE      接口地址，默认 https://ark.cn-beijing.volces.com/api/coding/v3
 *   ARK_MODEL         模型 ID，默认 deepseek-v4-1-flash-260910
 */

import type {
  ChatProvider,
  GenerateOptions,
  GenerateResult,
} from "./openai-compatible";
import { generateArticleWithProvider } from "./openai-compatible";

export const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
export const ARK_DEFAULT_MODEL = "deepseek-v4-1-flash-260910";

/** Coding Plan 当前支持的模型，供文档/UI 参考；实际以控制台为准，可用 ARK_MODEL 覆盖。 */
export const ARK_KNOWN_MODELS = [
  { id: "deepseek-v4-1-flash-260910", name: "DeepSeek V4.1 Flash（默认，快）" },
  { id: "deepseek-v4-pro-ga-260813", name: "DeepSeek V4 Pro（质量更好）" },
];

export function getArkApiKey(): string | undefined {
  return process.env.ARK_PLAN_API_KEY || process.env.ARK_API_KEY || undefined;
}

export function getArkProvider(): ChatProvider {
  return {
    id: "ark",
    label: "Ark Coding Plan",
    apiKey: getArkApiKey(),
    baseURL: process.env.ARK_API_BASE || ARK_DEFAULT_BASE_URL,
    model: process.env.ARK_MODEL || ARK_DEFAULT_MODEL,
    // Coding Plan 的推理模型输出偏长，进度估算取略高系数
    progressRatio: 0.3,
  };
}

export function generateArticle(
  transcript: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  return generateArticleWithProvider(getArkProvider(), transcript, options);
}
