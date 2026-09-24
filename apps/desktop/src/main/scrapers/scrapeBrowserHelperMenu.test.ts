import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildHelperToolbarHtml } from './scrapeBrowserHelperRuntime'

describe('scrape browser helper banner', () => {
  it('renders escaped instructions and actions without page injection', () => {
    const html = buildHelperToolbarHtml('preLogin', '<JavDB>')

    assert.match(html, /插件【&lt;JavDB&gt;】开启了预登入/)
    assert.match(html, /请在页面中完成登入后点击右侧的登入完成按钮/)
    assert.match(html, /javdex-helper-action:\/\/refresh/)
    assert.match(html, /javdex-helper-action:\/\/pre-login-done/)
    assert.doesNotMatch(html, /executeJavaScript|document\.querySelector/)

    const challengeHtml = buildHelperToolbarHtml('challenge')
    assert.match(challengeHtml, /请在页面中完成验证后点击右侧的验证通过按钮/)
  })
})
