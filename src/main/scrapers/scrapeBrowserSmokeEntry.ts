import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
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
  return new Promise((resolve) => server.close(() => resolve()))
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
      cookie: true
    })}\n`)
  } finally {
    controller.abort(new Error('smoke complete'))
    await host.dispose()
    await closeServer(server)
    fs.rmSync(userData, { recursive: true, force: true })
    app.quit()
  }
}
