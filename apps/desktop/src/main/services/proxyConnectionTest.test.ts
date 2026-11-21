import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isManualProxyUrl, networkProxyRoute, networkProxySettings, normalizeNetworkProxy } from '@shared/networkProxy'
import { httpProxyOptions } from '@library/net/httpProxyOptions'
import { electronProxyConfig, proxyCandidates, proxyCredentials } from '../utils/networkProxyTransport'

test('new configurations follow the system; enabled legacy routes keep their previous scope', () => {
  assert.deepEqual(networkProxySettings({}), { default: { mode: 'system' }, overrides: {} })
  const settings = networkProxySettings({
    proxyUrlEnabled: true,
    proxyUrl: ' http://127.0.0.1:7890 ',
    llmProxyUrlEnabled: true,
    llmProxyUrl: 'https://ai-proxy.test:8443'
  })
  assert.deepEqual(settings.overrides, {
    scrape: { mode: 'manual', url: 'http://127.0.0.1:7890' },
    updates: { mode: 'manual', url: 'http://127.0.0.1:7890' },
    llm: { mode: 'manual', url: 'https://ai-proxy.test:8443' }
  })
  assert.deepEqual(networkProxyRoute(settings, 'downloads'), { mode: 'system' })
  assert.deepEqual(networkProxySettings({ proxyUrlEnabled: false, proxyUrl: 'http://127.0.0.1:7890' }).overrides, {})
})

test('saved default and explicit overrides take precedence over legacy fields', () => {
  const saved = normalizeNetworkProxy({
    default: { mode: 'manual', url: ' https://proxy.test:8443/ ' },
    overrides: { scrape: { mode: 'direct' }, llm: { mode: 'system' } }
  })!
  const settings = networkProxySettings({ networkProxy: saved, proxyUrl: 'http://old.test:7890', proxyUrlEnabled: true })
  assert.deepEqual(networkProxyRoute(settings, 'scrape'), { mode: 'direct' })
  assert.deepEqual(networkProxyRoute(settings, 'llm'), { mode: 'system' })
  assert.deepEqual(networkProxyRoute(settings, 'updates'), { mode: 'manual', url: 'https://proxy.test:8443/' })
})

test('manual proxy inputs accept one HTTP or HTTPS endpoint', () => {
  assert.equal(isManualProxyUrl('http://127.0.0.1:7890'), true)
  assert.equal(isManualProxyUrl('https://proxy.test:8443/'), true)
  for (const url of ['', '127.0.0.1:7890', 'socks5://localhost:1080', 'http://proxy.test,path',
    'http://proxy.test/path', 'http://proxy.test?key=value']) {
    assert.equal(isManualProxyUrl(url), false, url)
  }
})

test('supports empty proxy passwords and matches IPv6 proxy authentication challenges', () => {
  const proxy = new URL('http://us%65r@[::1]:9000')
  assert.deepEqual(httpProxyOptions(proxy), { uri: 'http://[::1]:9000', token: 'Basic dXNlcjo=' })
  const challenge = { isProxy: true, scheme: 'basic', realm: 'test', host: '[::1]', port: 9000 }
  assert.deepEqual(proxyCredentials(proxy.href, challenge), ['user', ''])
  assert.deepEqual(proxyCredentials(proxy.href, { ...challenge, isProxy: false }), [])
})

test('scraper routing distinguishes system, direct and manual; protected requests keep ordered system rules', () => {
  assert.deepEqual(electronProxyConfig(), { mode: 'system' })
  assert.deepEqual(electronProxyConfig('direct://'), { mode: 'direct' })
  assert.deepEqual(electronProxyConfig('http://127.0.0.1:7890/'), { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' })
  assert.deepEqual(proxyCandidates('PROXY forward.test:80; HTTPS secure.test:443; SOCKS5 socks.test:1080; DIRECT'),
    ['http://forward.test:80', 'https://secure.test:443', 'socks5://socks.test:1080', ''])
})
