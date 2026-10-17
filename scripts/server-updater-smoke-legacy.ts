import assert from 'node:assert/strict'
import { request } from 'node:http'

/** Test-only transport across a loopback Docker port mapping, not a relaxed server policy. */
export function postLegacySmoke(options: {
  baseUrl: string
  authority: string
  operation: 'handshake.get' | 'writer.claim' | 'writer.status'
  body: unknown
  bearer?: string
}): Promise<unknown> {
  const url = new URL(`/manage/v1/${options.operation}`, options.baseUrl)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.match(options.authority, /^127\.0\.0\.1:\d{1,5}$/)
  const body = JSON.stringify(options.body)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false, signal: AbortSignal.timeout(10000), headers: {
      Host: options.authority, Origin: `http://${options.authority}`, 'X-Javdex-App-Version': '0.8.0',
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {})
    } }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) { response.destroy(new Error('Legacy smoke response exceeds its limit')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200, 'legacy smoke management request failed')
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}
