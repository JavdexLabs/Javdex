import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeProxyUrl } from './proxyConnectionTest'

test('normalizeProxyUrl accepts common proxy schemes', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl('  socks5://127.0.0.1:1080  '), 'socks5://127.0.0.1:1080')
})

test('normalizeProxyUrl rejects empty and invalid values', () => {
  assert.throws(() => normalizeProxyUrl(''), /请填写代理地址/)
  assert.throws(() => normalizeProxyUrl('127.0.0.1:7890'), /格式不正确/)
  assert.throws(() => normalizeProxyUrl('ftp://127.0.0.1:21'), /仅支持/)
})
