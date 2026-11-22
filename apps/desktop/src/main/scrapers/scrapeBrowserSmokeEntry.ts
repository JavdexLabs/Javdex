import { app } from 'electron'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { ScrapeBrowserHostModule } from './scrapeBrowser'

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('fixture port unavailable'))
      else resolve(address.port)
    })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function cleanupSmokeProfile(directory: string): void {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('javdex-scraper-smoke-'))
  if (process.platform !== 'win32') {
    fs.rmSync(directory, { recursive: true, force: true })
    return
  }
  // Chromium holds some profile files until the Electron process exits on Windows.
  const cleanup = spawn(process.execPath, [
    '-e',
    "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 12, retryDelay: 150 })",
    directory
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  cleanup.unref()
}

async function verifyRelaxedChallenges(host: ScrapeBrowserHostModule, port: number): Promise<void> {
  const url = (pathname: string, hostname = '127.0.0.1'): string => `http://${hostname}:${port}${pathname}`
  const options = { readySelector: '#expected', timeoutMs: 2400 }
  const controller = new AbortController()
  const acquire = () => host.acquire({ ownerId: 'relaxed-challenge-smoke', purpose: 'scrape', signal: controller.signal })
  const lease = await acquire()

  try {
    // The toolbar is the helper's other CDP page, separate from the scraper target.
    const { helper: { page, browser } } = host as unknown as { helper: { page: Page; browser: Browser } }
    const toolbar = browser.contexts().flatMap(context => context.pages()).find(view => view !== page)
    assert.ok(toolbar)
    const confirm = toolbar.locator('a[href$="challenge-passed"]')
    const clickConfirm = () => confirm.click({ timeout: 5000 })
    const [first] = await Promise.all([
      lease.fetchPage(url('/verification-content'), options),
      clickConfirm()
    ])
    assert.match(first, /fixture-ready/)
    await confirm.waitFor({ state: 'detached' })

    const challengeLoads: string[] = []
    toolbar.on('load', () => {
      const current = toolbar.url()
      if (current.includes('challenge-passed')) challengeLoads.push(current)
    })
    assert.match(await lease.fetchPage(url('/verification-content'), options), /fixture-ready/)
    assert.equal(await lease.pluginAction('waitForSelector', { selector: '#expected', timeoutMs: 1200 }), true)
    assert.deepEqual(challengeLoads, [])

    const [resolved] = await Promise.all([
      lease.fetchPage(url('/verification-blocked'), options),
      (async () => {
        await page.waitForURL('**/verification-blocked', { timeout: 3000 })
        assert.equal(await confirm.count(), 0, 'relaxed host must wait for expected content before prompting')
        await clickConfirm()
        // The fixture supplies its expected content after confirmation without starting another request.
        await page.evaluate("document.querySelector('main').innerHTML = '<p id=expected>fixture-ready</p>'")
      })()
    ])
    assert.match(resolved, /fixture-ready/)
    assert.equal(challengeLoads.length, 1)
    await confirm.waitFor({ state: 'detached' })

    await assert.rejects(lease.fetchPage(url('/verification-content', 'localhost'), {
      ...options, returnOnChallenge: true
    }), { code: 'CHALLENGE' })
  } finally { await lease.release() }

  const nextLease = await acquire()
  try {
    await assert.rejects(nextLease.fetchPage(url('/verification-content'), {
      ...options, returnOnChallenge: true
    }), { code: 'CHALLENGE' })
  } finally { await nextLease.release() }
}

/** Packaged/development smoke used by CI; never initializes the normal application. */
export async function runScrapeBrowserSmoke(): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scraper-smoke-'))
  app.setPath('userData', userData)
  await app.whenReady()

  const server = http.createServer((request, response) => {
    if (request.url === '/image.png') {
      response.setHeader('Content-Type', 'image/png')
      response.end(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ))
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/verification-content' || request.url === '/verification-blocked') {
      response.end(`<!doctype html><title>Verification fixture</title><main id="challenge-running">
        <h1>Fixture page</h1>${request.url === '/verification-content' ? '<p id="expected">fixture-ready</p>' : ''}
      </main>`)
      return
    }
    response.setHeader('Set-Cookie', 'scraperSmoke=present; Max-Age=3600; Path=/; SameSite=Lax')
    response.end(`<!doctype html>
      <html><head><meta property="og:title" content="Scraper Helper Fixture" /></head><body>
        <main>
          <h1>Scraper Helper Fixture</h1>
          <dl><dt>Release Date</dt><dd>2026-08-22</dd></dl>
          <label>Search <input aria-label="Search" /></label>
          <button onclick="window.open('/popup')">Open popup</button>
          <p id="cookie">cookie=${request.headers.cookie ?? ''}</p>
          <img src="/image.png" alt="fixture image" />
        </main>
      </body></html>`)
  })
  const port = await listen(server)
  const host = new ScrapeBrowserHostModule()
  const controller = new AbortController()
  try {
    await verifyRelaxedChallenges(host, port)
    const lease = await host.acquire({
      ownerId: 'smoke',
      purpose: 'agent-browser',
      signal: controller.signal
    })
    const opened = await lease.agentAction({
      action: 'open',
      url: `http://127.0.0.1:${port}/`,
      readySelector: 'main'
    })
    if (!opened.snapshot?.includes('Scraper Helper Fixture') || !/\[ref=e\d+\]/.test(opened.snapshot)) {
      throw new Error('ARIA snapshot did not contain fixture refs')
    }
    const pageFacts = opened.pageFacts as {
      metadataTags?: Array<{ key?: string; content?: string }>
      definitionLists?: Array<{ items?: Array<{ term?: string; value?: string }> }>
    } | undefined
    if (!pageFacts?.metadataTags?.some((item) =>
      item.key === 'og:title' && item.content === 'Scraper Helper Fixture'
    )) {
      throw new Error('open did not return structured metadata in pageFacts')
    }
    if (!pageFacts.definitionLists?.some((list) =>
      list.items?.some((item) => item.term === 'Release Date' && item.value === '2026-08-22')
    )) {
      throw new Error('open did not return definition lists in pageFacts')
    }
    const found = await lease.agentAction({ action: 'find', text: 'Open popup' })
    const buttonRef = found.matches?.find((match) => match.ref)?.ref
    if (!buttonRef) throw new Error('find did not return an actionable ref')
    await lease.agentAction({ action: 'click', target: buttonRef })
    const stealth = await lease.agentAction({
      action: 'evaluate',
      expression: '() => ({ webdriver: navigator.webdriver, userAgent: navigator.userAgent })'
    })
    const stealthValue = stealth.value as { webdriver?: unknown; userAgent?: unknown }
    if (stealthValue.webdriver !== false || /Electron/i.test(String(stealthValue.userAgent))) {
      throw new Error('stealth profile is inconsistent')
    }
    const beforeEvaluate = await lease.agentAction({ action: 'status' })
    const sanitized = await lease.agentAction({
      action: 'evaluate',
      expression: `() => {
        document.title = 'Detached mutation';
        return { title: document.title, hasInput: document.querySelector('input') !== null };
      }`
    })
    const sanitizedValue = sanitized.value as { title?: unknown; hasInput?: unknown }
    if (sanitizedValue.title !== 'Detached mutation' || sanitizedValue.hasInput !== false) {
      throw new Error('evaluate did not run against the sanitized detached document')
    }
    await lease.agentAction({ action: 'status' }).then((current) => {
      if (current.title !== beforeEvaluate.title) {
        throw new Error('evaluate mutated the live page')
      }
    })
    await lease.agentAction({
      action: 'evaluate',
      expression: `() => document['coo' + 'kie']`
    }).then(
      () => { throw new Error('evaluate allowed computed cookie access') },
      () => undefined
    )
    await lease.agentAction({ action: 'wait', timeoutMs: 1_000 })
    const status = await lease.agentAction({ action: 'status' })
    if (status.imageCacheEntries !== 1) {
      throw new Error('helper debugger did not retain the fixture image response')
    }
    await lease.recycle()
    const afterRestart = await lease.agentAction({
      action: 'open',
      url: `http://127.0.0.1:${port}/`,
      readySelector: '#cookie'
    })
    if (!afterRestart.snapshot?.includes('scraperSmoke=present')) {
      throw new Error('scraper profile cookie did not survive helper restart')
    }
    await lease.release()
    process.stdout.write(`${JSON.stringify({
      ok: true,
      refs: true,
      pageFacts: true,
      stealth: true,
      evaluateIsolation: true,
      debuggerImageCache: true,
      relaxedChallenge: true,
      cookie: true
    })}\n`)
  } finally {
    controller.abort(new Error('smoke complete'))
    await host.dispose()
    await closeServer(server)
    cleanupSmokeProfile(userData)
    app.quit()
  }
}
