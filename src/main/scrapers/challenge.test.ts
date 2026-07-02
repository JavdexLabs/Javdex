import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isCloudflareChallengeText } from './challenge'

const CF_HTML = `
  <html>
    <head>
      <title>Just a moment...</title>
      <script>window._cf_chl_opt = {};</script>
    </head>
    <body>
      <h1>Enable JavaScript and cookies to continue</h1>
    </body>
  </html>
`

describe('isCloudflareChallengeText', () => {
  it('trusts the official cf-mitigated challenge response header signal', () => {
    assert.equal(isCloudflareChallengeText('<html><main>normal page</main></html>'), false)
    assert.equal(
      isCloudflareChallengeText('<html><main>normal page</main></html>', { cfMitigated: true }),
      true
    )
    assert.equal(
      isCloudflareChallengeText('<html><main>normal page</main></html>', {
        cfMitigated: true,
        allowNormalContentOverride: true
      }),
      false
    )
  })

  it('detects classic JS challenge interstitial markers', () => {
    assert.equal(isCloudflareChallengeText(CF_HTML), true)
    assert.equal(
      isCloudflareChallengeText(
        '<html><div class="cf-browser-verification">...</div></html>'
      ),
      true
    )
    assert.equal(
      isCloudflareChallengeText(
        '<html><script src="/cdn-cgi/challenge-platform/h/b/scripts/flow.js"></script></html>'
      ),
      true
    )
    assert.equal(
      isCloudflareChallengeText('<html><div id="challenge-running"></div></html>'),
      true
    )
  })

  it('detects managed challenge markers', () => {
    assert.equal(
      isCloudflareChallengeText('<html><input name="chl-answer" value=""></html>'),
      true
    )
    assert.equal(
      isCloudflareChallengeText('<html><div class="managed-challenge">...</div></html>'),
      true
    )
  })

  it('detects body copy only with Cloudflare co-signals', () => {
    assert.equal(
      isCloudflareChallengeText(
        'Checking your browser before accessing example.com\nRay ID: abc123\nPerformance & security by Cloudflare'
      ),
      true
    )
    assert.equal(
      isCloudflareChallengeText('Checking your browser is important for security blogs'),
      false
    )
  })

  it('detects turnstile-only shells but not embedded widgets on content pages', () => {
    assert.equal(
      isCloudflareChallengeText(
        '<html><body><div class="cf-turnstile" data-sitekey="abc"></div></body></html>'
      ),
      true
    )
    assert.equal(
      isCloudflareChallengeText(
        '<html><main><h1>Login</h1><div class="cf-turnstile" data-sitekey="abc"></div></main></html>'
      ),
      false
    )
  })

  it('does not treat normal pages, helper copy, or vague phrases as Cloudflare', () => {
    assert.equal(
      isCloudflareChallengeText('<html><title>ABC-123</title><main>ready</main></html>'),
      false
    )
    assert.equal(isCloudflareChallengeText('JAV吧 - AV掌上夜店 - JAV8\n番号 演员 首页'), false)
    assert.equal(
      isCloudflareChallengeText('请在下方完成 Cloudflare 人机验证，完成后点击「验证通过」继续'),
      false
    )
    assert.equal(
      isCloudflareChallengeText(
        [
          '请在下方完成 Cloudflare 人机验证，完成后点击「验证通过」继续',
          '<html><title>VDD-203 搜索结果</title><body>',
          '<main><h1>关键字 VDD-203 搜索结果</h1>',
          '<section class="movie-list"><div class="item">VDD-203 FANZA限定</div></section>',
          '</main></body></html>'
        ].join('\n')
      ),
      false
    )
    assert.equal(
      isCloudflareChallengeText(
        [
          '请在下方完成 Cloudflare 人机验证，完成后点击「验证通过」继续',
          '<html><head><title>Just a moment...</title></head>',
          '<body><script>window._cf_chl_opt = {};</script></body></html>'
        ].join('\n')
      ),
      true
    )
    assert.equal(
      isCloudflareChallengeText(
        [
          '<html class="has-navbar-fixed-top"><head>',
          '<title> JavDB 成人影片數據庫 </title>',
          '</head><body data-domain="https://javdb573.com">',
          '<nav class="navbar is-fixed-top is-black is-fluid main-nav"></nav>',
          '<div class="search-bar-container"><input value="VDD-203"></div>',
          '<h1>關鍵字 VDD-203 搜索結果</h1>',
          '<div class="movie-list h cols-4 vcols-8"><div class="item">VDD-203</div></div>',
          '<script data-cf-beacon="{&quot;version&quot;:&quot;2024.11.0&quot;}"></script>',
          '</body></html>'
        ].join('\n'),
        { cfMitigated: true, allowNormalContentOverride: true }
      ),
      false
    )
    assert.equal(
      isCloudflareChallengeText('<html><title>Not Found</title><body>404</body></html>'),
      false
    )
    assert.equal(isCloudflareChallengeText('Verifying your account settings'), false)
    assert.equal(isCloudflareChallengeText('Attention required: update your profile'), false)
  })
})
