import type { PiRuntimeSettingsProjection } from './types'

/** New runs use a bounded policy; restored runs keep their frozen settings. */
export function agentCompactionPolicy(contextWindow: number): PiRuntimeSettingsProjection['compaction'] {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error('模型上下文窗口必须是正整数')
  return {
    enabled: true,
    reserveTokens: Math.min(16_384, Math.floor(contextWindow / 4)),
    keepRecentTokens: Math.min(20_000, Math.floor(contextWindow / 4))
  }
}
