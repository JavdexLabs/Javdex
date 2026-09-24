import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ActionNetworkCapture,
  ACTION_NETWORK_MAX_REQUESTS,
  isActionNetworkResourceType,
  sanitizeActionNetworkPostData,
  sanitizeActionNetworkUrl
} from './scrapeBrowserActionNetwork'

describe('action network capture', () => {
  it('keeps http(s) query strings and strips credentials', () => {
    assert.equal(
      sanitizeActionNetworkUrl('https://user:pass@xslist.org/search?query=三上悠亜&lg=zh'),
      'https://xslist.org/search?query=%E4%B8%89%E4%B8%8A%E6%82%A0%E4%BA%9C&lg=zh'
    )
    assert.equal(sanitizeActionNetworkUrl('javascript:void(0)'), null)
    assert.equal(isActionNetworkResourceType('XHR'), true)
    assert.equal(isActionNetworkResourceType('Image'), false)
  })

  it('redacts credential-bearing query values before exposing recent requests', () => {
    assert.equal(
      sanitizeActionNetworkUrl(
        'https://example.test/search?q=Alice&access_token=token-value&api_key=key-value&x-amz-signature=signed'
      ),
      'https://example.test/search?q=Alice&access_token=%5BREDACTED%5D&api_key=%5BREDACTED%5D&x-amz-signature=%5BREDACTED%5D'
    )
  })

  it('omits sensitive post bodies', () => {
    assert.equal(sanitizeActionNetworkPostData('query=hatano'), 'query=hatano')
    assert.equal(sanitizeActionNetworkPostData('password=secret'), undefined)
    assert.equal(sanitizeActionNetworkPostData('csrf=nonce-value'), undefined)
    assert.equal(sanitizeActionNetworkPostData('token=opaque-value'), undefined)
  })

  it('records only an active action window and does not label search', () => {
    const capture = new ActionNetworkCapture()
    capture.rememberRequest({
      requestId: 'before',
      url: 'https://xslist.org/search?query=early',
      method: 'GET',
      type: 'XHR'
    })
    assert.equal(capture.take(), undefined)

    capture.begin()
    capture.rememberRequest({
      requestId: 'search',
      url: 'https://xslist.org/search?query=三上悠亜&lg=zh',
      method: 'get',
      type: 'XHR'
    })
    capture.rememberResponse({ requestId: 'search', status: 200, type: 'XHR' })
    capture.rememberRequest({
      requestId: 'image',
      url: 'https://xslist.org/assets/logo.png',
      type: 'Image'
    })

    const requests = capture.take()
    assert.deepEqual(requests, [{
      method: 'GET',
      url: 'https://xslist.org/search?query=%E4%B8%89%E4%B8%8A%E6%82%A0%E4%BA%9C&lg=zh',
      resourceType: 'XHR',
      status: 200
    }])
    assert.equal(capture.take(), undefined)
  })

  it('keeps the newest requests when the action window overflows', () => {
    const capture = new ActionNetworkCapture()
    capture.begin()
    for (let index = 0; index < ACTION_NETWORK_MAX_REQUESTS + 3; index += 1) {
      capture.rememberRequest({
        requestId: `req-${index}`,
        url: `https://example.test/q?n=${index}`,
        type: 'Fetch'
      })
    }
    const requests = capture.take() ?? []
    assert.equal(requests.length, ACTION_NETWORK_MAX_REQUESTS)
    assert.equal(requests[0]?.url, 'https://example.test/q?n=3')
    assert.equal(requests.at(-1)?.url, `https://example.test/q?n=${ACTION_NETWORK_MAX_REQUESTS + 2}`)
  })
})
