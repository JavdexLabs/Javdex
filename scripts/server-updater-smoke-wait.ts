import { setTimeout as delay } from 'node:timers/promises'
import { ServerUpdateRequestError } from '../packages/http/src/updateClient'

const reconnectErrors = new Set(['无法连接更新助手', '更新助手连接超时', '更新请求连接中断，请查询状态后重试'])

/** Startup readiness is a read-only pinned status request, never a retry of a mutation. */
export async function waitForUpdateStatus<T>(query: () => Promise<T>, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60000)
  let lastError: Error | undefined
  do {
    try { return await query() } catch (error) {
      if (!(error instanceof Error)) throw error
      const retryable = error instanceof ServerUpdateRequestError
        ? error.statusCode === 503 && error.code === 'BUSINESS_NOT_READY'
        : reconnectErrors.has(error.message)
      if (!retryable) throw error
      lastError = error
    }
    if (Date.now() >= deadline) break
    await delay(Math.min(options.intervalMs ?? 250, deadline - Date.now()))
  } while (Date.now() < deadline)
  throw lastError
}
