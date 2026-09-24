/**
 * Minimax provider（OpenAI 兼容接口）。
 *
 * 环境变量：
 *   MINIMAX_API_KEY   API Key（必填）
 *   MINIMAX_API_BASE  接口地址，默认 https://api.minimaxi.com/v1
 *   MINIMAX_MODEL     模型 ID，默认 MiniMax-M2.7
 */

import type {
  ChatProvider,
  GenerateOptions,
  GenerateResult,
} from "./openai-compatible";
import { generateArticleWithProvider } from "./openai-compatible";

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
export const MINIMAX_DEFAULT_MODEL = "MiniMax-M2.7";

export function getMinimaxProvider(): ChatProvider {
  return {
    id: "minimax",
    label: "Minimax",
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: process.env.MINIMAX_API_BASE || MINIMAX_DEFAULT_BASE_URL,
    model: process.env.MINIMAX_MODEL || MINIMAX_DEFAULT_MODEL,
    progressRatio: 0.25,
  };
}

export function generateArticle(
  transcript: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  return generateArticleWithProvider(getMinimaxProvider(), transcript, options);
}

export type { GenerateOptions, GenerateResult, Highlight } from "./openai-compatible";
