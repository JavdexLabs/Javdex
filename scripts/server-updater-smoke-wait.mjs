import { setTimeout as delay } from 'node:timers/promises'

const reconnectErrors = new Set(['无法连接更新助手', '更新助手连接超时', '更新请求连接中断，请查询状态后重试'])

/** Startup readiness is a read-only pinned status request, never a retry of a mutation. */
export async function waitForUpdateStatus(query, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 60000)
  let lastError
  do {
    try { return await query() } catch (error) {
      if (!(error instanceof Error) || !reconnectErrors.has(error.message)) throw error
      lastError = error
    }
    if (Date.now() >= deadline) break
    await delay(Math.min(options.intervalMs ?? 250, deadline - Date.now()))
  } while (Date.now() < deadline)
  throw lastError
}
