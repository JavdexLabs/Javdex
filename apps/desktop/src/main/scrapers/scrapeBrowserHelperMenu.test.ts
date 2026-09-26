import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildHelperToolbarHtml, ScrapeBrowserHelperRuntime } from './scrapeBrowserHelperRuntime'

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

  it('continues after login confirmation while the homepage navigation is still pending', async () => {
    let markNavigationStarted!: () => void
    const navigationStarted = new Promise<void>((resolve) => { markNavigationStarted = resolve })
    const unfinishedNavigation = new Promise<void>(() => {})
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      setTitle: () => {},
      focus: () => {},
      loadURL: () => {
        markNavigationStarted()
        return unfinishedNavigation
      },
      webContents: {
        getURL: () => 'https://javdb.com/',
        getTitle: () => 'JavDB'
      }
    }
    const runtime = new ScrapeBrowserHelperRuntime() as unknown as {
      win: typeof win
      waitPreLogin: (window: typeof win, params: Record<string, unknown>) => Promise<{ url: string; title: string }>
      completePreLogin: (window: typeof win) => void
    }
    runtime.win = win

    const result = runtime.waitPreLogin(win, { url: 'https://javdb.com/', pluginName: 'JavDB' })
    await navigationStarted
    runtime.completePreLogin(win)

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      assert.deepEqual(await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Login confirmation remained blocked by navigation')), 1000)
        })
      ]), { url: 'https://javdb.com/', title: 'JavDB' })
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
})
