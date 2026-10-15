import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStructuredError } from '@shared/protocol/errors'
import { ManageHttpClient } from './manageClient'

test('management requests explain certificate failures without exposing underlying request data', async (t) => {
  let failure: unknown
  t.mock.method(globalThis, 'fetch', async () => { throw failure })
  const client = new ManageHttpClient({ baseUrl: 'https://example.test', appVersion: 'test' })
  const requests = [
    () => client.post('handshake.get', { input: {} }),
    () => client.putUpload('upload', Buffer.from('data'), 'application/octet-stream'),
    () => client.getAsset('cover.jpg')
  ]
  try {
    // Node fetch wraps the TLS failure in a TypeError.cause.
    failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('private TLS details'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    })
    for (const request of requests) {
      await assert.rejects(request, error => isStructuredError(error) &&
        error.code === 'CONNECTION_UNAVAILABLE' && /证书未受信任.*一次性配对/.test(error.message) &&
        !error.message.includes('private TLS details'))
    }
    failure = Object.assign(new Error('private certificate details'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    await assert.rejects(requests[0], error => isStructuredError(error) && /证书与服务器地址不匹配/.test(error.message))
    failure = Object.assign(new Error('private certificate details'), { code: 'CERT_HAS_EXPIRED' })
    await assert.rejects(requests[0], error => isStructuredError(error) && /有效期.*本机时间/.test(error.message))
  } finally { await client.close() }
})

test('management requests distinguish timeouts and keep unknown transport details private', async (t) => {
  let failure: unknown = new DOMException('private timeout details', 'TimeoutError')
  t.mock.method(globalThis, 'fetch', async () => { throw failure })
  const client = new ManageHttpClient({ baseUrl: 'http://example.test', appVersion: 'test' })
  try {
    await assert.rejects(client.post('handshake.get', {}), error => isStructuredError(error) && /取消或超时/.test(error.message))
    const unknown = new Error('private bearer token and request details')
    unknown.cause = unknown
    failure = unknown
    await assert.rejects(client.post('handshake.get', {}), error => isStructuredError(error) &&
      error.message === '无法连接远程资料库')
  } finally { await client.close() }
})
