/**
 * 启动期静态兜底名册（纯数据，零依赖，零 I/O）。
 *
 * 存在的唯一理由：让 Pi 启动时能立刻注册出可用的 provider 模型列表，
 * 而**不必**为此在启动路径上做网络请求（实测 qoder-cn 的 fetchModels 约 500ms，
 * 国际版凭据过期时还要多等一次 403）。
 *
 * 数据采集自 qoder-cn 上游真实名册（2026-10-28）。真正的 live 名册由
 * 惰性初始化在首次使用该 provider 时拉取覆盖。
 *
 * 注意：这里存的是 vendor 的 CatalogEntry 原始形态（而非 toPiModel 的输出），
 * 这样 toPiModel 的推导逻辑（thinkingLevelMap、displayNameFor 的错峰价标签、
 * resolveContextWindow 等）依然由 vendor 唯一实现，不会出现两份漂移的映射。
 */

import type { CatalogEntry } from "./vendor/dsh-connect-qoder/src/host/domain.ts";

/** qoder-cn（国内版）静态兜底名册 */
export const FALLBACK_ENTRIES_CN: readonly CatalogEntry[] = [
  {"id":"Auto","key":"auto","name":"Auto","isVL":true,"isReasoning":true,"supportsEffort":false,"alwaysThinking":false,"effortLevels":[],"maxInputTokens":200000,"defaultContextWindow":200000,"contextOptions":[200000],"priceFactor":0.5,"isFree":false,"isDefault":true},
  {"id":"Qwen3.8-Max","key":"qmodel_38max","name":"Qwen3.8-Max","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":false,"effortLevels":["xhigh","low","medium"],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0.2,"isFree":false,"isDefault":false,"promotion":{"active":true,"windowStart":"22:00","windowEnd":"08:00","timezone":"Asia/Shanghai","discountFactor":0.4,"beforePromotionPriceFactor":0.5,"badge":"错峰 4 折","description":"错峰时段4折优惠（10 PM-8 AM UTC+8）"}},
  {"id":"Qwen3.8-Flash","key":"qfmodel","name":"Qwen3.8-Flash","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":false,"effortLevels":["xhigh","low","medium"],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0,"isFree":true,"isDefault":false},
  {"id":"DeepSeek-V4-Pro","key":"dmodel","name":"DeepSeek-V4-Pro","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":false,"effortLevels":["high","max"],"maxInputTokens":96000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0.5,"isFree":false,"isDefault":false},
  {"id":"DeepSeek-Flash","key":"dfmodel","name":"DeepSeek-Flash","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":false,"effortLevels":["high","max","low"],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0,"isFree":true,"isDefault":false},
  {"id":"GLM-5.3","key":"gmodel","name":"GLM-5.3","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":true,"effortLevels":["high","low","max"],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0.8,"isFree":false,"isDefault":false},
  {"id":"GLM-5.3-Flash","key":"gfmodel","name":"GLM-5.3-Flash","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":true,"effortLevels":["high","max"],"maxInputTokens":1000000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0.1,"isFree":false,"isDefault":false},
  {"id":"Kimi-K3.1-Pro","key":"kmodel_latest","name":"Kimi-K3.1-Pro","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":true,"effortLevels":["high","low","max"],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":1,"isFree":false,"isDefault":false},
  {"id":"Kimi-K2.8-Preview","key":"kmodel","name":"Kimi-K2.8-Preview","isVL":true,"isReasoning":true,"supportsEffort":true,"alwaysThinking":true,"effortLevels":["high","low","max"],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0.8,"isFree":false,"isDefault":false},
  {"id":"MiniMax-M3.1-Flash","key":"mmodel","name":"MiniMax-M3.1-Flash","isVL":true,"isReasoning":false,"supportsEffort":false,"alwaysThinking":false,"effortLevels":[],"maxInputTokens":180000,"defaultContextWindow":200000,"contextOptions":[200000,400000,1000000],"priceFactor":0.1,"isFree":false,"isDefault":false},
] as unknown as readonly CatalogEntry[];

/** qoder（国际版）静态兜底名册：凭据过期时无法采集，保持为空即注册兜底占位模型 */
export const FALLBACK_ENTRIES_INTL: readonly CatalogEntry[] = [];

export function fallbackEntriesFor(regionId: string): readonly CatalogEntry[] {
  return regionId === "qoder-cn" ? FALLBACK_ENTRIES_CN : FALLBACK_ENTRIES_INTL;
}
