import { request } from 'node:http'

/** Internal business probes need an explicit authority; Node fetch ignores Host overrides. */
export function requestBusiness(url: URL, authority: string, options: { body?: string; timeoutMs?: number; appVersion?: string } = {}): Promise<{ status: number; ok: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.body === undefined ? 'GET' : 'POST',
      headers: { Host: authority, ...(options.appVersion ? { 'X-Javdex-App-Version': options.appVersion } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) }) },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000) }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) { response.destroy(new Error('业务探测响应超限')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const status = response.statusCode ?? 0
        resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end(options.body)
  })
}
