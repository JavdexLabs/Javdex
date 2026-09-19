import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFetchReferer } from './scrapeBrowserReferer'

describe('resource Referer policy', () => {
  it('omits missing, blank and non-web page origins', () => {
    for (const page of [undefined, '', 'about:blank', 'file:///tmp/page.html', 'invalid']) {
      assert.equal(resolveFetchReferer(undefined, page, 'https://images.test/a.jpg'), null)
    }
  })
  it('keeps real page origins for same-site and CDN requests without credentials or query data', () => {
    assert.equal(resolveFetchReferer('session', 'https://user:pass@site.test/video?token=secret#x', 'https://cdn.test/a.jpg'), 'https://site.test/')
    assert.equal(resolveFetchReferer(undefined, 'https://site.test/detail', 'https://site.test/a.jpg'), 'https://site.test/')
    assert.equal(resolveFetchReferer('omit', 'https://site.test/', 'https://site.test/a.jpg'), null)
  })
  it('omits downgrade and unrelated loopback or LAN origins', () => {
    assert.equal(resolveFetchReferer(undefined, 'https://site.test/', 'http://images.test/a.jpg'), null)
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.1', '172.16.0.1', '192.168.1.1', '[::1]', '[fd00::1]']) {
      assert.equal(resolveFetchReferer(undefined, 'http://site.test/', `http://${host}/image`), null)
    }
    assert.equal(resolveFetchReferer(undefined, 'http://localhost:8080/page', 'http://localhost:8080/image'), 'http://localhost:8080/')
  })
  it('validates explicit sources under the same policy', () => {
    assert.equal(resolveFetchReferer('javascript:alert(1)', undefined, 'https://images.test/a'), null)
    assert.equal(resolveFetchReferer('https://site.test/path?q=secret', undefined, 'https://images.test/a'), 'https://site.test/')
  })
})
