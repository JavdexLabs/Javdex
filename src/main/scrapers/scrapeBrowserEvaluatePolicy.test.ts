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
    assert.equal(
      containsForbiddenBrowserEvaluateApi(
        `() => { const value = document.title; return { selected: value, note: 'constructor' } }`
      ),
      false
    )
  })

  it('still rejects executable references and computed access to forbidden APIs', () => {
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => fetch('/private')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => window.fetch('/private')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => window['fetch']('/private')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => new WebSocket('wss://example.test')`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => eval('1 + 1')`), true)
    assert.equal(
      containsForbiddenBrowserEvaluateApi(String.raw`() => f\u0065tch('https://attacker.test')`),
      true
    )
    assert.equal(
      containsForbiddenBrowserEvaluateApi(String.raw`() => F\u0075nction('return globalThis')()`),
      true
    )
  })

  it('rejects credential, storage and sensitive form access', () => {
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.cookie'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => document['cookie']`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => localStorage.getItem("session")'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.querySelector("input").value'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.querySelector("input[type=password]")'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => navigator.credentials.get()'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => document['coo' + 'kie']`), true)
    assert.equal(containsForbiddenBrowserEvaluateApi(`() => Reflect.get(document, 'cookie')`), true)
    assert.equal(
      containsForbiddenBrowserEvaluateApi(`() => Reflect.get(document.querySelector('input'), 'value')`),
      true
    )
    assert.equal(containsForbiddenBrowserEvaluateApi('() => navigator.sendBeacon("/leak")'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.body.textContent'), false)
  })

  it('rejects live-page mutation and computed property access', () => {
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.body.remove()'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.body.append("changed")'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => document.title = "changed"'), false)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => ["safe", "data"]'), false)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => ["safe", "data"][0]'), true)
    assert.equal(containsForbiddenBrowserEvaluateApi('() => this'), true)
    assert.equal(
      containsForbiddenBrowserEvaluateApi('() => { const { document } = this; return document.title }'),
      true
    )
    assert.equal(containsForbiddenBrowserEvaluateApi('() => setTimeout("location.reload()", 0)'), true)
  })

  it('rejects destructuring aliases that recover live-realm capabilities', () => {
    assert.equal(
      containsForbiddenBrowserEvaluateApi(
        `() => { const { constructor: C } = (() => {}); return C('return globalThis')() }`
      ),
      true
    )
    assert.equal(
      containsForbiddenBrowserEvaluateApi(
        `() => { const {constructor:F}=(()=>{}); return F("return document.cookie")() }`
      ),
      true
    )
    assert.equal(
      containsForbiddenBrowserEvaluateApi(
        `() => { const { sendBeacon: send } = navigator; return send('/leak') }`
      ),
      true
    )
    assert.equal(
      containsForbiddenBrowserEvaluateApi(
        `() => { const { 'constructor': C } = (() => {}); return C('return globalThis')() }`
      ),
      true
    )
    assert.equal(
      containsForbiddenBrowserEvaluateApi(
        `() => { const { ['con' + 'structor']: C } = (() => {}); return C('return globalThis')() }`
      ),
      true
    )
  })

  it('uses one normalized evaluator and drains timeout cleanup before rejecting', async () => {
    const prepared = prepareBrowserEvaluate('() => ({ title: document.title })', 50)
    assert.equal(prepared.timeoutMs, 500)
    assert.match(prepared.source, /JSON\.parse/)
    assert.match(prepared.source, /safeDocument/)
    assert.match(prepared.source, /input, textarea, select/)
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
