import { BrowserWindow, dialog, session, net, type Session, type WebContents } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { diagnoseCloudflareChallenge, isCloudflareChallengeText } from './challenge'
import {
  hasImageMagicBytes,
  ImageBodyLruCache,
  isImageNetworkResource,
  normalizeNetworkUrl
} from './scrapeBrowserImageCache'
import { cleanUserAgent, getScrapeUaProfile } from './scrapeUaProfile'
import { prioritizeInspectLinks } from './scrapeBrowserInspect'
import {
  prepareBrowserEvaluate,
  runPreparedBrowserEvaluate
} from './scrapeBrowserEvaluatePolicy'
import {
  canResolveScrapePage,
  canResolveScrapeSelector,
  ScrapeBrowserWaitBudget
} from './scrapeBrowserWaitBudget'
import {
  ScrapeBrowserChallengeError,
  type ScrapeBrowserFetchBufferOptions,
  type ScrapeBrowserFetchPageOptions,
  type ScrapeBrowserResourceResponse
} from './scrapeBrowserTypes'

/** Default fallback selector indicating a real (non-challenge) page. */
const DEFAULT_CONTENT_SELECTOR = 'main, article, .movie-list .item, .movie-panel-info, h1'
const DOM_SETTLE_MIN_ELAPSED_MS = 1500
const DOM_SETTLE_STABLE_MS = 1000
const VERIFICATION_TIMEOUT_MS = 180_000

/** Toolbar injected into challenge pages so the user can drive verification. */
const TOOLBAR_JS = `
(function(){
  var BAR_H = 48;
  var existing = document.getElementById('__cf_helper_bar__');
  if (existing) existing.remove();

  var host = document.createElement('div');
  host.id = '__cf_helper_bar__';
  host.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;width:100%;height:' + BAR_H + 'px';

  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>'
    + '.bar{display:flex;align-items:center;gap:12px;width:100%;height:' + BAR_H + 'px;padding:0 16px;box-sizing:border-box;background:#101014;border-bottom:1px solid #2c2c38;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.6)}'
    + '.tip{flex:1 1 auto;min-width:0;margin:0;color:#b6b6c2;font-size:13px;line-height:1.4}'
    + '.actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}'
    + '.btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:32px;padding:0 16px;margin:0;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;line-height:1;white-space:nowrap}'
    + '.btn-refresh{background:#23232e;color:#f2f2f5;border:1px solid #2c2c38}'
    + '.btn-save{background:#23232e;color:#d6d6de;border:1px solid #2c2c38}'
    + '.btn-pass{background:#6c5ce7;color:#fff;border:1px solid #6c5ce7;font-weight:600}'
    + '.btn:hover{filter:brightness(1.08)}'
    + '</style>'
    + '<div class="bar">'
    + '<p class="tip">请在下方完成 Cloudflare 人机验证，完成后点击「验证通过」继续</p>'
    + '<div class="actions">'
    + '<button type="button" class="btn btn-refresh" id="cf-refresh">刷新</button>'
    + '<button type="button" class="btn btn-save" id="cf-save">保存页面</button>'
    + '<button type="button" class="btn btn-pass" id="cf-pass">验证通过</button>'
    + '</div>'
    + '</div>';

  shadow.getElementById('cf-refresh').onclick = function(){ console.log('__CF_ACTION__:refresh'); };
  shadow.getElementById('cf-save').onclick = function(){ console.log('__CF_ACTION__:save'); };
  shadow.getElementById('cf-pass').onclick = function(){ console.log('__CF_ACTION__:pass'); };

  (document.documentElement || document.body).appendChild(host);
  if (document.body) document.body.style.paddingTop = BAR_H + 'px';
})();
`

const REMOVE_TOOLBAR_JS = `
(function(){
  var bar = document.getElementById('__cf_helper_bar__');
  if (bar) bar.remove();
  if (document.body) document.body.style.paddingTop = '';
})();
`

interface Brand {
  brand: string
  version: string
}

function getResponseHeader(
  headers: Record<string, string | string[]> | undefined,
  name: string
): string | null {
  if (!headers) return null
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase())
  if (!key) return null
  const value = headers[key]
  return Array.isArray(value) ? value.join(',') : value
}

/**
 * Injected at document-start in the verification window. Masks the two cheapest
 * automation tells (navigator.webdriver / missing window.chrome) so Cloudflare's
 * client-side fingerprinting matches a real Chrome.
 */
const STEALTH_DOC_JS = `
try {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
} catch (e) {}
try {
  if (!window.chrome) { window.chrome = { runtime: {} }; }
} catch (e) {}
`

/**
 * Ensure a `sec-ch-ua`(-style) brand list contains the `"Google Chrome"` brand.
 * Electron/Chromium emits only `"Chromium"` + a GREASE token, which Cloudflare
 * treats as an instant bot signal. We preserve Chromium's natural GREASE token
 * and append `"Google Chrome"` with the same version as Chromium. If the source
 * header is missing entirely, we synthesize a plausible Chrome value.
 */
function injectGoogleChrome(existing: string | undefined, major: string, full = false): string {
  const ver = full ? `${major}.0.0.0` : major
  if (existing && existing.trim()) {
    if (/google chrome/i.test(existing)) return existing
    // Reuse the Chromium brand's version if present so versions stay aligned.
    const m = existing.match(/"Chromium";v="([^"]+)"/i)
    const chromeVer = m ? m[1] : ver
    return `${existing.trim()}, "Google Chrome";v="${chromeVer}"`
  }
  const grease = full ? '"Not(A:Brand";v="8.0.0.0"' : '"Not(A:Brand";v="8"'
  return `${grease}, "Chromium";v="${ver}", "Google Chrome";v="${ver}"`
}

/**
 * Manages a single visible "verification" browser window used to fetch JavDB
 * pages. The user solves Cloudflare manually (refresh / 验证通过 buttons); the
 * persistent session then carries the clearance cookie for subsequent requests,
 * which resolve automatically.
 */
export class ScrapeBrowserHelperRuntime {
  private win: BrowserWindow | null = null
  private ses: Session | null = null
  private manualPass = false
  private stealthApplied = false
  private headerStealthInstalled = false
  private currentMainFrameCfMitigated = false
  /** Origin of the most recently loaded page, used as the image Referer. */
  private lastOrigin = 'https://javdb.com'
  /**
   * All page loads share the single scraper window, so a second navigation
   * cancels the first and both callers would read back the same DOM. Page
   * fetches therefore run one at a time.
   */
  private pageQueue: Promise<void> = Promise.resolve()

  /** Image bodies captured from the scraper window via CDP Network. */
  private readonly imageBodyCache = new ImageBodyLruCache()
  private networkCaptureWc: WebContents | null = null
  /** Bumped on cache clear so in-flight getResponseBody cannot write stale pages. */
  private networkCacheGeneration = 0
  /** requestId → URLs seen on that request (including redirects). */
  private readonly networkRequestUrls = new Map<string, Set<string>>()
  /** requestId → metadata for in-flight image responses awaiting body. */
  private readonly pendingImageRequests = new Map<
    string,
    { mimeType: string; status: number; type: string }
  >()
  private readonly onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown
  ): void => {
    this.handleDebuggerNetworkMessage(method, params)
  }

  constructor(private readonly onWindowClosed?: () => void) {}

  async initialize(signal?: AbortSignal): Promise<{ targetId: string }> {
    signal?.throwIfAborted()
    const win = this.ensureWindow()
    await this.ensureStealth(win)
    signal?.throwIfAborted()
    return { targetId: win.webContents.getOrCreateDevToolsTargetId() }
  }

  private getSession(): Session {
    if (!this.ses) {
      this.ses = session.defaultSession
      this.ses.setUserAgent(cleanUserAgent())
      this.installHeaderStealth(this.ses)
    }
    return this.ses
  }

  /**
   * Rewrite outgoing request headers on EVERY request (including the first one
   * Cloudflare evaluates) so they look like a real Chrome:
   *  - force the clean, Electron-free User-Agent
   *  - repair `sec-ch-ua` / `sec-ch-ua-full-version-list` to include "Google Chrome",
   *    deduplicating case-variant keys (Chromium emits lowercase `sec-ch-ua`).
   * Electron's native client hints only take effect from the 2nd request, so this
   * deterministic rewrite is what actually fixes the initial challenge.
   */
  private installHeaderStealth(ses: Session): void {
    if (this.headerStealthInstalled) return
    this.headerStealthInstalled = true

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const profile = getScrapeUaProfile()
      const headers = details.requestHeaders
      let secChUa: string | undefined
      let fullVerList: string | undefined

      // Collect + strip every sec-ch-ua* variant and force the clean UA.
      for (const key of Object.keys(headers)) {
        const lk = key.toLowerCase()
        if (lk === 'sec-ch-ua') {
          secChUa = headers[key]
          delete headers[key]
        } else if (lk === 'sec-ch-ua-full-version-list') {
          fullVerList = headers[key]
          delete headers[key]
        } else if (lk === 'user-agent') {
          delete headers[key]
        }
      }

      headers['User-Agent'] = profile.userAgent
      headers['sec-ch-ua'] = injectGoogleChrome(secChUa, profile.major)
      if (fullVerList) {
        headers['sec-ch-ua-full-version-list'] = injectGoogleChrome(fullVerList, profile.major, true)
      }
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'sec-ch-ua-mobile')) {
        headers['sec-ch-ua-mobile'] = '?0'
      }
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'sec-ch-ua-platform')) {
        headers['sec-ch-ua-platform'] = profile.secChUaPlatform
      }

      callback({ requestHeaders: headers })
    })

    ses.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame') {
        this.currentMainFrameCfMitigated =
          getResponseHeader(details.responseHeaders, 'cf-mitigated')?.toLowerCase() === 'challenge'
      }
      callback({})
    })
  }

  /** Apply (or clear) a proxy for the scraper session. */
  async setProxy(proxyUrl: string | undefined, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const ses = this.getSession()
    if (proxyUrl && proxyUrl.trim()) {
      await ses.setProxy({ proxyRules: proxyUrl.trim() })
    } else {
      await ses.setProxy({ mode: 'direct' })
    }
    signal?.throwIfAborted()
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const ua = cleanUserAgent()
    this.getSession()

    const win = new BrowserWindow({
      width: 1080,
      height: 820,
      show: false,
      title: '元数据刮削 · 浏览器',
      backgroundColor: '#101014',
      webPreferences: {
        session: this.getSession(),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    win.setMenuBarVisibility(false)
    win.webContents.setUserAgent(ua)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-attach-webview', (event) => event.preventDefault())

    // Show the Cloudflare helper toolbar only on real challenge pages.
    const syncToolbar = (): void => {
      void this.syncChallengeToolbar(win)
    }
    win.webContents.on('dom-ready', syncToolbar)
    win.webContents.on('did-finish-load', syncToolbar)

    // Listen for toolbar button clicks signalled via console.log.
    win.webContents.on('console-message', (event) => {
      const message = event.message
      if (message.includes('__CF_ACTION__:refresh')) {
        win.webContents.reload()
      } else if (message.includes('__CF_ACTION__:save')) {
        void this.savePageDebug(win)
      } else if (message.includes('__CF_ACTION__:pass')) {
        this.manualPass = true
      }
    })

    win.on('closed', () => {
      if (this.win !== win) return
      this.teardownNetworkBodyCapture()
      this.clearNetworkImageCache()
      this.win = null
      this.stealthApplied = false
      this.onWindowClosed?.()
    })

    this.win = win
    return win
  }

  /**
   * Make the verification window indistinguishable from a real Chrome at the
   * client-hint level. Electron's `setUserAgent` only rewrites the UA string and
   * leaves `sec-ch-ua` / `navigator.userAgentData` reporting "Chromium" without
   * "Google Chrome" — an instant Cloudflare bot flag. We use CDP
   * `Network.setUserAgentOverride` (the same mechanism Chrome DevTools uses) to
   * align the UA string, the client-hint headers AND navigator.userAgentData,
   * injecting the missing "Google Chrome" brand while preserving Chromium's real
   * GREASE token.
   */
  private detachDebugger(wc: WebContents): void {
    this.teardownNetworkBodyCapture()
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      /* ignore */
    }
  }

  private clearNetworkImageCache(): void {
    this.networkCacheGeneration += 1
    this.imageBodyCache.clear()
    this.networkRequestUrls.clear()
    this.pendingImageRequests.clear()
  }

  private teardownNetworkBodyCapture(): void {
    const wc = this.networkCaptureWc
    this.networkCaptureWc = null
    if (!wc || wc.isDestroyed()) return
    try {
      wc.debugger.removeListener('message', this.onDebuggerMessage)
    } catch {
      /* ignore */
    }
  }

  private installNetworkBodyCapture(wc: WebContents): void {
    if (this.networkCaptureWc === wc) return
    this.teardownNetworkBodyCapture()
    this.networkCaptureWc = wc
    wc.debugger.on('message', this.onDebuggerMessage)
  }

  private rememberNetworkRequestUrl(requestId: string, url: string | undefined): void {
    if (!url || !normalizeNetworkUrl(url)) return
    let urls = this.networkRequestUrls.get(requestId)
    if (!urls) {
      urls = new Set()
      this.networkRequestUrls.set(requestId, urls)
    }
    urls.add(url)
  }

  private handleDebuggerNetworkMessage(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return
    const p = params as Record<string, unknown>
    const requestId = typeof p.requestId === 'string' ? p.requestId : ''
    if (!requestId) return

    if (method === 'Network.requestWillBeSent') {
      const request = p.request as { url?: string } | undefined
      this.rememberNetworkRequestUrl(requestId, request?.url)
      const redirect = p.redirectResponse as { url?: string } | undefined
      this.rememberNetworkRequestUrl(requestId, redirect?.url)
      return
    }

    if (method === 'Network.responseReceived') {
      const response = p.response as
        | { url?: string; status?: number; mimeType?: string }
        | undefined
      this.rememberNetworkRequestUrl(requestId, response?.url)
      const type = typeof p.type === 'string' ? p.type : ''
      const status = typeof response?.status === 'number' ? response.status : 0
      const mimeType = typeof response?.mimeType === 'string' ? response.mimeType : ''
      if (!isImageNetworkResource({ type, mimeType, status })) {
        return
      }
      this.pendingImageRequests.set(requestId, { mimeType, status, type })
      return
    }

    if (method === 'Network.loadingFinished') {
      if (!this.pendingImageRequests.has(requestId)) {
        this.networkRequestUrls.delete(requestId)
        return
      }
      void this.captureNetworkImageBody(requestId)
      return
    }

    if (method === 'Network.loadingFailed') {
      this.pendingImageRequests.delete(requestId)
      this.networkRequestUrls.delete(requestId)
    }
  }

  private async captureNetworkImageBody(requestId: string): Promise<void> {
    const wc = this.networkCaptureWc
    if (!wc || wc.isDestroyed()) return
    if (!wc.debugger.isAttached()) return

    const urls = this.networkRequestUrls.get(requestId)
    this.pendingImageRequests.delete(requestId)
    this.networkRequestUrls.delete(requestId)
    if (!urls?.size) return

    const generation = this.networkCacheGeneration
    try {
      const result = (await wc.debugger.sendCommand('Network.getResponseBody', {
        requestId
      })) as { body?: string; base64Encoded?: boolean }
      if (generation !== this.networkCacheGeneration) return
      const raw = typeof result.body === 'string' ? result.body : ''
      if (!raw) return
      const buf = result.base64Encoded
        ? Buffer.from(raw, 'base64')
        : Buffer.from(raw, 'binary')
      if (!hasImageMagicBytes(buf)) return
      this.imageBodyCache.set(urls, buf)
    } catch {
      /* Body may already be evicted from the debugger; fetchBuffer will fall back. */
    }
  }

  private async applyStealthViaCdp(win: BrowserWindow): Promise<void> {
    const wc = win.webContents
    const profile = getScrapeUaProfile()

    // Load a blank document so navigator.userAgentData is queryable.
    await wc.loadURL('about:blank').catch(() => {})

    // Capture Chromium's *natural* client hints (correct GREASE token).
    let natural: {
      brands?: Brand[]
      mobile?: boolean
      platform?: string
      high?: {
        platform?: string
        platformVersion?: string
        architecture?: string
        bitness?: string
        model?: string
        uaFullVersion?: string
        fullVersionList?: Brand[]
      }
    } | null = null
    try {
      const raw = await wc.executeJavaScript(
        `(async () => {
          const uad = navigator.userAgentData;
          if (!uad) return null;
          let high = {};
          try {
            high = await uad.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model','uaFullVersion','fullVersionList']);
          } catch (e) {}
          return JSON.stringify({ brands: uad.brands, mobile: uad.mobile, platform: uad.platform, high });
        })()`
      )
      if (raw) natural = JSON.parse(raw)
    } catch {
      /* fall back to synthesized values below */
    }

    const { userAgent: ua, major, fullVersion } = profile

    const withGoogleChrome = (list: Brand[] | undefined, fallbackVer: string): Brand[] => {
      let brands = (list && list.length ? list : [{ brand: 'Chromium', version: fallbackVer }]).filter(
        (b) => !/electron|javdex/i.test(b.brand)
      )
      if (!brands.some((b) => b.brand === 'Google Chrome')) {
        const chromium = brands.find((b) => /chromium/i.test(b.brand))
        brands = [...brands, { brand: 'Google Chrome', version: chromium?.version || fallbackVer }]
      }
      return brands
    }

    const brands = withGoogleChrome(natural?.brands, major)
    const fullVersionList = withGoogleChrome(
      natural?.high?.fullVersionList,
      fullVersion
    ).map((b) => ({ brand: b.brand, version: b.version.includes('.') ? b.version : `${b.version}.0.0.0` }))

    const high = natural?.high ?? {}
    const platform = high.platform || natural?.platform || profile.platform
    const platformVersion = high.platformVersion || profile.platformVersion

    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Network.enable')
    this.installNetworkBodyCapture(wc)
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_DOC_JS })
    await wc.debugger.sendCommand('Network.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
      platform,
      userAgentMetadata: {
        brands,
        fullVersionList,
        fullVersion: high.uaFullVersion || fullVersion,
        platform,
        platformVersion,
        architecture: high.architecture || profile.architecture,
        model: high.model || '',
        mobile: !!natural?.mobile,
        bitness: high.bitness || profile.bitness,
        wow64: false
      }
    })
  }

  private async ensureStealth(win: BrowserWindow): Promise<void> {
    if (this.stealthApplied) return
    const wc = win.webContents

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.applyStealthViaCdp(win)
        this.stealthApplied = true
        return
      } catch (err) {
        this.detachDebugger(wc)
        console.warn(
          `[scrapeBrowser] CDP stealth attempt ${attempt}/2 failed:`,
          (err as Error).message
        )
        if (attempt < 2) await this.sleep(250)
      }
    }

    console.warn(
      '[scrapeBrowser] CDP stealth unavailable after retries; HTTP client hints still rewritten via session hook'
    )
  }

  private async readPageChallengeSample(win: BrowserWindow): Promise<string> {
    return win.webContents
      .executeJavaScript(
        `(() => {
          const title = document.title || '';
          const bar = document.getElementById('__cf_helper_bar__');
          const barParent = bar && bar.parentNode;
          if (bar) bar.remove();
          const bodyText = ((document.body && document.body.innerText) || '').slice(0, 8000);
          const html = (document.documentElement && document.documentElement.outerHTML || '').slice(0, 30000);
          if (bar && barParent) barParent.appendChild(bar);
          return title + '\\n' + bodyText + '\\n' + html;
        })()`
      )
      .catch(() => '')
  }

  private async savePageDebug(win: BrowserWindow): Promise<void> {
    const sample = await this.readPageChallengeSample(win)
    const diagnosis = diagnoseCloudflareChallenge(sample, {
      cfMitigated: this.currentMainFrameCfMitigated,
      allowNormalContentOverride: true
    })
    const html = await this.readHtml(win).catch(() => '')
    const pageUrl = win.webContents.getURL()
    const suggestedName = (() => {
      try {
        const { hostname, pathname } = new URL(pageUrl)
        const slug = pathname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page'
        return `${hostname}-${slug}-${Date.now()}.html`
      } catch {
        return `challenge-debug-${Date.now()}.html`
      }
    })()

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '保存页面',
      defaultPath: suggestedName,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (canceled || !filePath) return

    await fs.writeFile(filePath, html, 'utf8')
    const metaPath = `${filePath.replace(/\.html?$/i, '')}.challenge-meta.json`
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          url: pageUrl,
          cfMitigated: this.currentMainFrameCfMitigated,
          diagnosis
        },
        null,
        2
      ),
      'utf8'
    )

    const noticePath = path.basename(metaPath)
    await dialog.showMessageBox(win, {
      type: 'info',
      title: '页面已保存',
      message: '页面 HTML 与 challenge 诊断信息已保存。',
      detail: `${path.basename(filePath)}\n${noticePath}`,
      buttons: ['确定']
    })
  }

  private async isPageChallenge(win: BrowserWindow): Promise<boolean> {
    const sample = await this.readPageChallengeSample(win)
    const challenge = isCloudflareChallengeText(sample, {
      cfMitigated: this.currentMainFrameCfMitigated,
      allowNormalContentOverride: true
    })
    if (!challenge) this.currentMainFrameCfMitigated = false
    return challenge
  }

  private async syncChallengeToolbar(win: BrowserWindow): Promise<void> {
    const challenge = await this.isPageChallenge(win)
    if (challenge) {
      await win.webContents.executeJavaScript(TOOLBAR_JS).catch(() => {})
      if (!win.isVisible()) win.show()
      win.focus()
      return
    }
    await win.webContents.executeJavaScript(REMOVE_TOOLBAR_JS).catch(() => {})
  }

  /**
   * Load a URL in the verification window and return its HTML once the page is
   * ready — either auto-detected real content, or after the user clicks
   * 「验证通过」. Throws on timeout or if the window is closed.
   *
   * Concurrent calls are queued rather than run in parallel, so a plugin may
   * safely fan out over several URLs without them clobbering each other.
   */
  async fetchPage(
    url: string,
    options: ScrapeBrowserFetchPageOptions = {},
    signal?: AbortSignal
  ): Promise<string> {
    // The timeout budget starts inside loadPageExclusively, so queueing never
    // eats into a caller's timeoutMs.
    const run = this.pageQueue.then(
      () => this.loadPageExclusively(url, options, signal),
      () => this.loadPageExclusively(url, options, signal)
    )
    this.pageQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async loadPageExclusively(
    url: string,
    options: ScrapeBrowserFetchPageOptions,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted()
    const {
      readySelector = DEFAULT_CONTENT_SELECTOR,
      timeoutMs = 180000,
      settleWhenText,
      returnOnChallenge = false
    } = options
    const settlePattern = settleWhenText?.source
    const settleFlags = settleWhenText?.flags.includes('i') ? 'i' : ''
    const win = this.ensureWindow()
    this.manualPass = false
    this.currentMainFrameCfMitigated = false

    // Align client hints with a real Chrome before hitting Cloudflare.
    await this.ensureStealth(win)

    try {
      this.lastOrigin = new URL(url).origin
    } catch {
      /* keep previous origin */
    }

    if (!win.isVisible()) win.show()

    // Drop previous page images so cover/sample downloads cannot reuse a stale body.
    this.clearNetworkImageCache()

    await win.loadURL(url).catch(() => {
      /* navigation errors are tolerated; we poll the document state below */
    })

    const start = Date.now()
    const waitBudget = new ScrapeBrowserWaitBudget(start, timeoutMs, VERIFICATION_TIMEOUT_MS)
    let stableContentSince = 0
    let lastStableSignature = ''
    let focusedForChallenge = false

    while (true) {
      signal?.throwIfAborted()
      if (!this.win || this.win.isDestroyed()) {
        throw new Error('验证窗口已被关闭')
      }

      if (this.manualPass) {
        // “验证通过” only requests an immediate re-check. Cloudflare may still
        // be redirecting, so the destination must pass the normal readiness loop.
        this.manualPass = false
        stableContentSince = 0
        lastStableSignature = ''
      }

      const info = await win.webContents
        .executeJavaScript(
          `(() => {
            const title = document.title || '';
            const bodyText = (document.body && document.body.innerText) || '';
            const sample = bodyText + ' ' + title;
            const text = sample.slice(0, 5000);
            const hasContent = !!document.querySelector(${JSON.stringify(readySelector)});
            const readyState = document.readyState || '';
            const textLength = text.trim().length;
            const bodyChildCount = document.body ? document.body.children.length : 0;
            const htmlLength = document.documentElement ? document.documentElement.outerHTML.length : 0;
            const pageUrl = location.href;
            let settled = false;
            ${
              settlePattern
                ? `try {
              settled = new RegExp(${JSON.stringify(settlePattern)}, ${JSON.stringify(
                    settleFlags
                  )}).test(text);
            } catch (e) { settled = false; }`
                : 'settled = false;'
            }
            const signature = [pageUrl, title, readyState, textLength, bodyChildCount, htmlLength].join('|');
            return { title, hasContent, settled, readyState, textLength, bodyChildCount, htmlLength, pageUrl, signature };
          })()`
        )
        .catch(() => ({
          title: '',
          hasContent: false,
          settled: false,
          readyState: '',
          textLength: 0,
          bodyChildCount: 0,
          htmlLength: 0,
          pageUrl: '',
          signature: ''
        }))

      const isChallenge = await this.isPageChallenge(win)
      const waitStatus = waitBudget.update(Date.now(), isChallenge)
      if (waitStatus === 'verification-timeout') {
        win.show()
        win.focus()
        throw new Error('验证超时：请在弹出的窗口中完成 Cloudflare 验证后点击「验证通过」')
      }
      if (waitStatus === 'page-timeout') break
      if (isChallenge && !focusedForChallenge) {
        await this.syncChallengeToolbar(win)
        focusedForChallenge = true
      }
      if (isChallenge && returnOnChallenge) {
        throw new ScrapeBrowserChallengeError({
          url: info.pageUrl || win.webContents.getURL(),
          title: info.title
        })
      }
      const frameIdle = !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame()
      const hasAnyDom =
        info.textLength > 0 || info.bodyChildCount > 0 || info.htmlLength > 200
      const hasTerminalDomState =
        info.readyState === 'complete' &&
        frameIdle &&
        hasAnyDom &&
        Date.now() - start > DOM_SETTLE_MIN_ELAPSED_MS
      const mayResolve = canResolveScrapePage(
        isChallenge,
        info.hasContent || info.settled || hasTerminalDomState
      )
      if (mayResolve) {
        if (stableContentSince === 0 || lastStableSignature !== info.signature) {
          stableContentSince = Date.now()
          lastStableSignature = info.signature
        }
        if (Date.now() - stableContentSince > DOM_SETTLE_STABLE_MS) {
          return this.readHtml(win)
        }
      } else {
        stableContentSince = 0
        lastStableSignature = ''
      }

      await this.sleep(700, signal)
    }

    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
    throw new Error('页面加载超时：请检查 URL 或网络连接后重试')
  }

  private async readHtml(win: BrowserWindow): Promise<string> {
    return win.webContents.executeJavaScript('document.documentElement.outerHTML')
  }

  private async htmlRegion(
    win: BrowserWindow,
    params: Record<string, unknown>
  ): Promise<{ url: string; selector: string; html: string; truncated: boolean }> {
    const selector =
      typeof params.selector === 'string' && params.selector.trim() ? params.selector.trim() : 'body'
    const maxLength =
      typeof params.maxLength === 'number' && Number.isFinite(params.maxLength)
        ? Math.max(200, Math.min(20000, Math.round(params.maxLength)))
        : 12000
    return win.webContents.executeJavaScript(
      `(() => {
        const selector = ${JSON.stringify(selector)};
        const maxLength = ${maxLength};
        const el = document.querySelector(selector) || document.body;
        if (!el) throw new Error('Selector not found: ' + selector);
        const raw = (el.outerHTML || '').replace(/\\s+/g, ' ').trim();
        return {
          url: location.href,
          selector,
          html: raw.slice(0, maxLength),
          truncated: raw.length > maxLength
        };
      })()`
    )
  }

  private async evaluate(win: BrowserWindow, params: Record<string, unknown>): Promise<unknown> {
    const expression =
      typeof params.expression === 'string' ? params.expression.trim() : ''
    const prepared = prepareBrowserEvaluate(
      expression,
      typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
    )
    return runPreparedBrowserEvaluate({
      execute: () => win.webContents.executeJavaScript(prepared.source),
      timeoutMs: prepared.timeoutMs,
      onTimeout: () => {
        // Reload destroys the timed-out execution context before the helper can serve another request.
        if (!win.isDestroyed()) win.webContents.reload()
      }
    })
  }

  private async pageStatus(
    win: BrowserWindow
  ): Promise<{ url: string; title: string; isChallenge: boolean; imageCacheEntries: number }> {
    const url = win.webContents.getURL()
    const title = await win.webContents.executeJavaScript(`document.title || ''`).catch(() => '')
    const isChallenge = await this.isPageChallenge(win)
    return { url, title, isChallenge, imageCacheEntries: this.imageBodyCache.size }
  }

  async performAction(
    action: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const win = this.ensureWindow()
    await this.ensureStealth(win)
    if (!win.isVisible()) win.show()

    switch (action) {
      case 'present':
        win.show()
        win.focus()
        return this.pageStatus(win)
      case 'snapshot':
        return this.snapshot(win, params)
      case 'inspect':
        return this.inspect(win, params)
      case 'click':
        return this.click(win, readSelector(params))
      case 'type':
        return this.type(win, readSelector(params), readText(params), params.clear === true)
      case 'press':
        return this.press(win, readKey(params))
      case 'waitForSelector':
        return this.waitForSelector(win, readSelector(params), readTimeout(params.timeoutMs))
      case 'wait':
        await this.sleep(readTimeout(params.timeoutMs), signal)
        return true
      case 'html':
        return this.readHtml(win)
      case 'htmlRegion':
        return this.htmlRegion(win, params)
      case 'evaluate':
        return this.evaluate(win, params)
      case 'status':
        return this.pageStatus(win)
      case 'url':
        return win.webContents.getURL()
      default:
        throw new Error(`Unsupported browser action: ${action}`)
    }
  }

  private async snapshot(
    win: BrowserWindow,
    params: Record<string, unknown>
  ): Promise<{ url: string; title: string; text: string }> {
    const maxTextLength =
      typeof params.maxTextLength === 'number' && Number.isFinite(params.maxTextLength)
        ? Math.max(200, Math.min(20000, Math.round(params.maxTextLength)))
        : 5000
    return win.webContents.executeJavaScript(
      `(() => {
        const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim();
        return {
          url: location.href,
          title: document.title || '',
          text: text.slice(0, ${maxTextLength})
        };
      })()`
    )
  }

  private async inspect(win: BrowserWindow, params: Record<string, unknown>): Promise<unknown> {
    const maxLinks =
      typeof params.maxLinks === 'number' && Number.isFinite(params.maxLinks)
        ? Math.max(10, Math.min(160, Math.round(params.maxLinks)))
        : 80
    const maxTextLength =
      typeof params.maxTextLength === 'number' && Number.isFinite(params.maxTextLength)
        ? Math.max(200, Math.min(12000, Math.round(params.maxTextLength)))
        : 4000
    const maxRegionHtmlLength =
      typeof params.maxRegionHtmlLength === 'number' && Number.isFinite(params.maxRegionHtmlLength)
        ? Math.max(400, Math.min(8000, Math.round(params.maxRegionHtmlLength)))
        : 2800
    const prioritizeInspectLinksSource = prioritizeInspectLinks.toString()
    return win.webContents.executeJavaScript(
      `(() => {
        const prioritizeLinks = (${prioritizeInspectLinksSource});
        const cssPath = (el) => {
          if (!el || !el.tagName) return '';
          if (el.id) return '#' + CSS.escape(el.id);
          const parts = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && parts.length < 4) {
            let part = cur.tagName.toLowerCase();
            if (cur.classList && cur.classList.length) {
              part += '.' + Array.from(cur.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
            }
            const parent = cur.parentElement;
            if (parent) {
              const same = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
              if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
            }
            parts.unshift(part);
            cur = parent;
          }
          return parts.join(' > ');
        };
        const compactHtml = (html) => html.replace(/\\s+/g, ' ').trim().slice(0, ${maxRegionHtmlLength});
        const linkRegion = (el) => {
          if (el.closest('nav.breadcrumb, .breadcrumb')) return 'breadcrumb';
          if (el.closest('.attributes, .video-details, #video_info, .movie-info, .info-panel, .panel-block')) {
            return 'metadata';
          }
          return 'other';
        };
        const inspectLinkFlags = (el) => {
          const inContentRegion = Boolean(el.closest(
            'main, article, [role="main"], #content, .content, .main, .grid, #results, .results, .search-results, .search-result, .movie-list'
          ));
          const inNavigationRegion = Boolean(el.closest(
            'nav, header, footer, [role="navigation"], .navbar, .navigation, .nav, .menu, .dropdown-menu'
          ));
          const linkText = (el.innerText || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
          const inLocaleRegion = Boolean(el.closest(
            '.language-switcher, .locale-switcher, [class*="language-switch"], [class*="locale-switch"]'
          ));
          const isLocaleLink = Boolean(
            el.hasAttribute('hreflang') ||
            el.hasAttribute('data-language') ||
            el.hasAttribute('data-locale') ||
            inLocaleRegion ||
            /^(?:繁體中文|简体中文|簡體中文|English|日本語|한국의|한국어|Melayu|ไทย|Deutsch|Français|Tiếng Việt|Bahasa Indonesia|Filipino|Português)$/i.test(linkText)
          );
          return { inContentRegion, inNavigationRegion, isLocaleLink };
        };
        const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim();
        const forms = Array.from(document.querySelectorAll('form')).slice(0, 12).map((form) => ({
          selector: cssPath(form),
          action: form.getAttribute('action') || '',
          method: form.getAttribute('method') || 'get',
          inputs: Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 20).map((input) => ({
            selector: cssPath(input),
            name: input.getAttribute('name') || '',
            type: input.getAttribute('type') || input.tagName.toLowerCase(),
            placeholder: input.getAttribute('placeholder') || '',
            value: input.getAttribute('value') || ''
          })),
          buttons: Array.from(form.querySelectorAll('button, input[type="submit"]')).slice(0, 10).map((button) => ({
            selector: cssPath(button),
            text: (button.innerText || button.getAttribute('value') || '').replace(/\\s+/g, ' ').trim(),
            type: button.getAttribute('type') || ''
          }))
        }));
        const looseInputs = Array.from(document.querySelectorAll('input, textarea, select'))
          .filter((input) => !input.closest('form'))
          .slice(0, 20)
          .map((input) => ({
            selector: cssPath(input),
            name: input.getAttribute('name') || '',
            type: input.getAttribute('type') || input.tagName.toLowerCase(),
            placeholder: input.getAttribute('placeholder') || '',
            value: input.getAttribute('value') || ''
          }));
        if (looseInputs.length) {
          forms.push({ selector: 'document', action: location.href, method: 'interactive', inputs: looseInputs, buttons: [] });
        }
        const linkCandidates = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          element: a,
          href: new URL(a.getAttribute('href'), location.href).toString(),
          ...inspectLinkFlags(a)
        }));
        const links = prioritizeLinks(linkCandidates, ${maxLinks}).map((link) => ({
          text: (link.element.innerText || link.element.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          href: link.href,
          region: linkRegion(link.element),
          parentSelector: cssPath(link.element.parentElement)
        }));
        const regionSpecs = [
          { label: '面包屑导航', selector: 'nav.breadcrumb, .breadcrumb' },
          { label: '元数据属性区', selector: '.attributes, .video-details, #video_info, .movie-info, .info-panel' },
          { label: '标题区', selector: 'h1, .title.is-4, .video-title' },
          { label: '页面主区块', selector: '.main, main, #content, article.page' }
        ];
        const domRegions = [];
        const seenRegionSelectors = new Set();
        for (const spec of regionSpecs) {
          const el = document.querySelector(spec.selector);
          if (!el) continue;
          const selector = cssPath(el);
          if (seenRegionSelectors.has(selector)) continue;
          seenRegionSelectors.add(selector);
          domRegions.push({
            label: spec.label,
            selector,
            html: compactHtml(el.outerHTML)
          });
        }
        const definitionLists = Array.from(document.querySelectorAll('dl'))
          .slice(0, 10)
          .map((dl) => {
            const items = [];
            let currentTerm = '';
            for (const child of Array.from(dl.children)) {
              if (child.tagName === 'DT') {
                currentTerm = (child.innerText || '').replace(/\\s+/g, ' ').trim();
              } else if (child.tagName === 'DD' && currentTerm) {
                items.push({
                  term: currentTerm,
                  value: (child.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
                  valueHtml: compactHtml(child.innerHTML).slice(0, 600)
                });
                currentTerm = '';
              }
            }
            return { selector: cssPath(dl), items };
          })
          .filter((list) => list.items.length > 0);
        const metadataTags = Array.from(document.querySelectorAll(
          'meta[property^="og:"], meta[name^="twitter:"], meta[itemprop]'
        ))
          .slice(0, 30)
          .map((meta) => ({
            key: meta.getAttribute('property') || meta.getAttribute('name') || meta.getAttribute('itemprop') || '',
            content: (meta.getAttribute('content') || '').replace(/\\s+/g, ' ').trim().slice(0, 320)
          }))
          .filter((item) => item.key && item.content);
        const structuredData = [];
        const stringifyStructuredValue = (value) => {
          if (Array.isArray(value)) {
            return value.map(stringifyStructuredValue).filter(Boolean).join(', ');
          }
          if (value && typeof value === 'object') {
            if (typeof value.name === 'string') return value.name;
            if (typeof value.url === 'string') return value.url;
            if (value.ratingValue != null) {
              const count = value.ratingCount ?? value.reviewCount;
              return String(value.ratingValue) + (count != null ? ' (' + String(count) + ')' : '');
            }
            return '';
          }
          return value == null ? '' : String(value);
        };
        for (const [index, script] of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10).entries()) {
          try {
            const parsed = JSON.parse(script.textContent || 'null');
            const roots = Array.isArray(parsed) ? parsed : [parsed];
            const nodes = roots.flatMap((root) => root && Array.isArray(root['@graph']) ? root['@graph'] : [root]);
            for (const node of nodes) {
              if (!node || typeof node !== 'object') continue;
              for (const key of ['name', 'headline', 'description', 'image', 'datePublished', 'duration', 'aggregateRating', 'ratingValue', 'genre', 'actor', 'director', 'url', 'birthDate', 'height', 'alternateName', 'nationality']) {
                const value = stringifyStructuredValue(node[key]);
                if (!value) continue;
                structuredData.push({
                  selector: 'script[type="application/ld+json"]:nth-of-type(' + (index + 1) + ')',
                  key,
                  value: value.replace(/\\s+/g, ' ').trim().slice(0, 600)
                });
              }
            }
          } catch {
            // Ignore malformed JSON-LD and continue with visible evidence.
          }
        }
        const labeledRows = [];
        const seenLabeledRows = new Set();
        for (const row of Array.from(document.querySelectorAll('div, li, p, tr'))) {
          if (labeledRows.length >= 48) break;
          const labelElement = Array.from(row.children).find((child) => {
            if (!child.matches('span, strong, b, dt, th')) return false;
            const label = (child.innerText || '').replace(/\\s+/g, ' ').trim();
            return label.length > 0 && label.length <= 40 && /[:：]$/.test(label);
          });
          if (!labelElement) continue;
          const rawLabel = (labelElement.innerText || '').replace(/\\s+/g, ' ').trim();
          const label = rawLabel.replace(/[:：]$/, '');
          const fullText = (row.innerText || '').replace(/\\s+/g, ' ').trim();
          const value = fullText.slice(rawLabel.length).trim();
          if (!label || !value || value.length > 600) continue;
          const selector = cssPath(row);
          const dedupeKey = label + '\\0' + value;
          if (seenLabeledRows.has(dedupeKey)) continue;
          seenLabeledRows.add(dedupeKey);
          labeledRows.push({
            selector,
            label,
            value: value.slice(0, 320),
            links: Array.from(row.querySelectorAll('a[href]'))
              .slice(0, 12)
              .map((link) => new URL(link.getAttribute('href'), location.href).toString())
          });
        }
        return {
          url: location.href,
          title: document.title || '',
          text: text.slice(0, ${maxTextLength}),
          forms,
          links,
          domRegions,
          definitionLists,
          metadataTags,
          structuredData: structuredData.slice(0, 48),
          labeledRows
        };
      })()`
    )
  }

  private async click(win: BrowserWindow, selector: string): Promise<boolean> {
    return win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Selector not found: ${escapeJsMessage(selector)}');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return true;
      })()`
    )
  }

  private async type(
    win: BrowserWindow,
    selector: string,
    text: string,
    clear: boolean
  ): Promise<boolean> {
    return win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Selector not found: ${escapeJsMessage(selector)}');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if (${clear ? 'true' : 'false'}) el.value = '';
        el.value = (el.value || '') + ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
    )
  }

  private async press(win: BrowserWindow, key: string): Promise<boolean> {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    return true
  }

  private async waitForSelector(
    win: BrowserWindow,
    selector: string,
    timeoutMs: number
  ): Promise<boolean> {
    const started = Date.now()
    const waitBudget = new ScrapeBrowserWaitBudget(started, timeoutMs, VERIFICATION_TIMEOUT_MS)
    let focusedForChallenge = false
    while (true) {
      const isChallenge = await this.isPageChallenge(win)
      const found = isChallenge
        ? false
        : await win.webContents
            .executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
            .catch(() => false)
      if (canResolveScrapeSelector(isChallenge, found)) return true

      const waitStatus = waitBudget.update(Date.now(), isChallenge)
      if (waitStatus === 'verification-timeout') {
        await this.syncChallengeToolbar(win)
        throw new Error('验证超时：请在弹出的窗口中完成 Cloudflare 验证后点击「验证通过」')
      }
      if (waitStatus === 'page-timeout') break
      if (isChallenge && !focusedForChallenge) {
        await this.syncChallengeToolbar(win)
        focusedForChallenge = true
      } else if (!isChallenge) {
        focusedForChallenge = false
      }

      await this.sleep(250)
    }
    throw new Error(`Timed out waiting for selector: ${selector}`)
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timeout)
        reject(signal.reason instanceof Error ? signal.reason : new Error('浏览器操作已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Download a binary asset through the scraper session (UA, proxy, cookies).
   * Prefers image bodies already loaded in the scraper window (CDP Network cache)
   * to avoid a second HTTP fetch. Falls back to session net.request.
   * During scraping, use session referer (current page origin). Manual imports use
   * `{ referer: 'omit' }` without creating a second page target.
   */
  async fetchBuffer(
    url: string,
    options?: ScrapeBrowserFetchBufferOptions,
    signal?: AbortSignal
  ): Promise<Buffer> {
    signal?.throwIfAborted()
    const cached = this.imageBodyCache.get(url)
    if (cached) return cached
    return (await this.fetchBufferResponse(url, options, signal)).body
  }

  async fetchBufferResponse(
    url: string,
    options?: ScrapeBrowserFetchBufferOptions,
    signal?: AbortSignal
  ): Promise<ScrapeBrowserResourceResponse> {
    signal?.throwIfAborted()
    const ses = this.getSession()
    const profile = getScrapeUaProfile()
    const referer = resolveFetchReferer(options?.referer, this.lastOrigin)
    return new Promise<ScrapeBrowserResourceResponse>((resolve, reject) => {
      const request = net.request({ url, session: ses, useSessionCookies: true })
      const onAbort = (): void => {
        request.abort()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('浏览器操作已取消'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = <T>(fn: (value: T) => void, value: T): void => {
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      request.setHeader('User-Agent', profile.userAgent)
      if (referer) request.setHeader('Referer', referer)
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        request.setHeader(name, value)
      }
      const chunks: Buffer[] = []
      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          finish(reject, new Error(`HTTP ${response.statusCode}`))
          response.on('data', () => {})
          return
        }
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () =>
          finish(resolve, {
            statusCode: response.statusCode,
            body: Buffer.concat(chunks),
            etag: response.headers.etag?.[0]
          })
        )
        response.on('error', (error) => finish(reject, error))
      })
      request.on('error', (error) => finish(reject, error))
      request.end()
    })
  }

  close(): void {
    // Keep the persistent Session so cookies and Cloudflare clearance survive window recycling.
    this.clearNetworkImageCache()
    const win = this.win
    this.win = null
    this.stealthApplied = false
    if (win && !win.isDestroyed()) {
      this.detachDebugger(win.webContents)
      win.close()
    } else {
      this.teardownNetworkBodyCapture()
    }
  }
}

function resolveFetchReferer(
  mode: 'omit' | 'session' | string | undefined,
  sessionOrigin: string
): string | null {
  if (mode === 'omit') return null
  if (mode === 'session' || mode === undefined) {
    const origin = sessionOrigin.replace(/\/$/, '')
    return `${origin}/`
  }
  if (typeof mode === 'string' && mode.trim()) {
    const trimmed = mode.trim()
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
  }
  const origin = sessionOrigin.replace(/\/$/, '')
  return `${origin}/`
}

function readSelector(params: Record<string, unknown>): string {
  if (typeof params.selector !== 'string' || !params.selector.trim()) {
    throw new Error('Browser selector must be a non-empty string')
  }
  return params.selector.trim()
}

function readText(params: Record<string, unknown>): string {
  return params.text == null ? '' : String(params.text)
}

function readKey(params: Record<string, unknown>): string {
  if (typeof params.key !== 'string' || !params.key.trim()) {
    throw new Error('Browser key must be a non-empty string')
  }
  return params.key.trim()
}

function readTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(250, Math.min(120000, Math.round(value)))
    : 30000
}

function escapeJsMessage(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
