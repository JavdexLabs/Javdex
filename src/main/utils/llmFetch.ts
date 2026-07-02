import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from 'undici'
import { getSettings } from '../settings/settingsStore'
import { resolveLlmProxyUrl } from '@shared/types'

let cachedProxyUrl = ''
let cachedDispatcher: ProxyAgent | undefined

function resolveLlmDispatcher(): ProxyAgent | undefined {
  const proxyUrl = resolveLlmProxyUrl(getSettings())
  if (!proxyUrl) {
    cachedProxyUrl = ''
    cachedDispatcher = undefined
    return undefined
  }
  if (proxyUrl === cachedProxyUrl && cachedDispatcher) return cachedDispatcher
  cachedProxyUrl = proxyUrl
  cachedDispatcher = new ProxyAgent(proxyUrl)
  return cachedDispatcher
}

/** Reset cached proxy dispatcher (tests). */
export function resetLlmFetchProxyCacheForTests(): void {
  cachedProxyUrl = ''
  cachedDispatcher = undefined
}

/** Fetch for LLM provider APIs; routes through settings.llmProxyUrl when set. */
export async function llmFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = resolveLlmDispatcher()
  if (!dispatcher) {
    return fetch(url, init)
  }

  const undiciInit: UndiciRequestInit = {
    ...(init as UndiciRequestInit),
    dispatcher
  }
  const response = await undiciFetch(url, undiciInit)
  return response as unknown as Response
}
