import { networkProxyRoute, networkProxySettings } from '@shared/networkProxy'
import { getSettings } from '../settings/settingsStore'
import { fetchWithNetworkProxy } from './networkProxyTransport'

let transport = fetchWithNetworkProxy

export function setLlmFetchTransportForTests(next?: typeof fetchWithNetworkProxy): void {
  transport = next ?? fetchWithNetworkProxy
}

export function llmFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return transport('llm', networkProxyRoute(networkProxySettings(getSettings()), 'llm'), input, init)
}
