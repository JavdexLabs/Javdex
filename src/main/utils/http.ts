import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { cleanUserAgent } from '../scrapers/scrapeUaProfile'

/**
 * Build an axios instance. When a proxy URL is supplied, all requests are
 * routed through an https-proxy-agent; otherwise a direct connection is used.
 */
export function createHttpClient(proxyUrl?: string): AxiosInstance {
  const config: AxiosRequestConfig = {
    timeout: 20000,
    headers: {
      'User-Agent': cleanUserAgent(),
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7'
    },
    maxRedirects: 5,
    // We handle non-2xx ourselves where needed.
    validateStatus: (s) => s >= 200 && s < 400
  }

  if (proxyUrl && proxyUrl.trim()) {
    const agent = new HttpsProxyAgent(proxyUrl.trim())
    config.httpAgent = agent
    config.httpsAgent = agent
    // Disable axios' own proxy handling so the agent takes over.
    config.proxy = false
  }

  return axios.create(config)
}

/** Fetch a URL as a Buffer (used for image downloads). */
export async function fetchBuffer(url: string, proxyUrl?: string): Promise<Buffer> {
  const client = createHttpClient(proxyUrl)
  const res = await client.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
  return Buffer.from(res.data)
}
