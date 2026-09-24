/**
 * 文章生成 provider 入口。
 *
 * 目前支持：
 *   - ark      火山引擎方舟 Coding Plan（ARK_PLAN_API_KEY / ARK_API_KEY）
 *   - minimax  Minimax（MINIMAX_API_KEY）
 *
 * 选择规则（AI_PROVIDER 环境变量）：
 *   AI_PROVIDER=ark | minimax        显式指定，优先级最高
 *   未设置时自动探测：配置了方舟 Key 用方舟，否则用 Minimax
 *   两者都未配置则抛出明确错误
 */

import type {
  ChatProvider,
  GenerateOptions,
  GenerateResult,
} from "./openai-compatible";
import { generateArticleWithProvider } from "./openai-compatible";
import { getArkApiKey, getArkProvider } from "./ark";
import { getMinimaxProvider } from "./minimax";

export type ProviderId = "ark" | "minimax";

export const PROVIDER_IDS: ProviderId[] = ["ark", "minimax"];

/** 允许的别名，便于按习惯书写 AI_PROVIDER */
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  ark: "ark",
  "ark-plan": "ark",
  "ark-coding": "ark",
  arkplan: "ark",
  volcengine: "ark",
  volces: "ark",
  "coding-plan": "ark",
  minimax: "minimax",
  mini_max: "minimax",
  "minimax-cn": "minimax",
};

export function resolveProviderId(): ProviderId {
  const raw = (process.env.AI_PROVIDER || "").trim().toLowerCase();

  if (raw) {
    const id = PROVIDER_ALIASES[raw];
    if (!id) {
      throw new Error(
        `Unknown AI_PROVIDER "${raw}". Valid values: ${PROVIDER_IDS.join(", ")}`
      );
    }
    return id;
  }

  if (getArkApiKey()) return "ark";
  if (process.env.MINIMAX_API_KEY) return "minimax";

  throw new Error(
    "No AI provider configured. Set ARK_PLAN_API_KEY (火山方舟 Coding Plan) or MINIMAX_API_KEY in .env"
  );
}

export function resolveProvider(): ChatProvider {
  const id = resolveProviderId();
  return id === "ark" ? getArkProvider() : getMinimaxProvider();
}

/**
 * 生成文章（自动按上述规则选择 provider）。
 */
export function generateArticle(
  transcript: string,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const provider = resolveProvider();
  console.log(
    `[AI] Provider: ${provider.id} (${provider.label}), model: ${provider.model}, customPrompt=${options.systemPrompt ? "yes" : "no"}`
  );
  return generateArticleWithProvider(provider, transcript, options);
}

export type { GenerateOptions, GenerateResult, Highlight } from "./openai-compatible";
