import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  containsForbiddenBrowserEvaluateApi,
  prepareBrowserEvaluate,
  runPreparedBrowserEvaluate
} from './scrapeBrowserEvaluatePolicy'

describe('browser evaluate policy', () => {
  it('allows forbidden API names inside diagnostic strings, comments and regular expressions', () => {
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => /query|search|fetch/i.test(location.href)`), false)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => 'fetch XMLHttpRequest WebSocket'`), false)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => ['fetch', 'WebSocket']`), false)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => { /* fetch() */ return document.title }`), false)
  })

  it('still rejects executable references and computed access to forbidden APIs', () => {
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => fetch('/private')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => window.fetch('/private')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => window['fetch']('/private')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => new WebSocket('wss://example.test')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => eval('1 + 1')`), true)
  })

  it('rejects credential, storage and sensitive form access', () => {
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.cookie'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => document['cookie']`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => localStorage.getItem("session")'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.querySelector("input").value'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.querySelector("input[type=password]")'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => navigator.credentials.get()'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.body.textContent'), false)
  })

  it('uses one normalized evaluator and drains timeout cleanup before rejecting', async () => {
    const prepared = prepareBrowserEvaluate('() => ({ title: document.title })', 50)
    assert.equal(prepared.timeoutMs, 500)
    assert.match(prepared.source, /JSON\.parse/)
    let cleaned = false
    await assert.rejects(
      runPreparedBrowserEvaluate({
        execute: async () => new Promise<never>(() => undefined),
        timeoutMs: 1,
        onTimeout: async () => { cleaned = true }
      }),
      /evaluate timed out/
    )
    assert.equal(cleaned, true)
  })
})
