import { llmFetch } from '../../../utils/llmFetch'
import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import type { JsonModelResponse, JsonModelUsage } from './openaiChatAdapter'

export class LlmHttpError extends Error {
  constructor(message: string, readonly status: number, readonly headers: Headers) {
    super(message)
    this.name = 'LlmHttpError'
  }
}

export interface NativeTextResponse {
  text: string
  usage?: JsonModelUsage
}

export async function requestNativePayload<T extends { error?: { message?: string } }>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  config: ResolvedLlmModelRequestConfig
): Promise<T> {
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000)
  const response = await llmFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout
  })
  const text = await response.text()
  let payload: T
  try {
    payload = JSON.parse(text) as T
  } catch {
    if (!response.ok) throw new LlmHttpError(`模型请求失败：HTTP ${response.status}`, response.status, response.headers)
    throw new Error('模型服务返回了非 JSON 响应')
  }
  if (!response.ok) {
    throw new LlmHttpError(payload.error?.message || `模型请求失败：HTTP ${response.status}`, response.status, response.headers)
  }
  if (payload.error) throw new Error(payload.error.message || '模型请求失败')
  return payload
}

export function nativeTextToJson<T>(response: NativeTextResponse): JsonModelResponse<T> {
  if (!response.text.trim()) throw new Error('模型服务未返回内容')
  try {
    return { json: JSON.parse(response.text) as T, rawText: response.text, usage: response.usage }
  } catch {
    throw new Error(`模型未按 JSON 格式返回：${response.text.slice(0, 240)}`)
  }
}
