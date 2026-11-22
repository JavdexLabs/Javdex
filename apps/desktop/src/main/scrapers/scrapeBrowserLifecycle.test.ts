import assert from 'node:assert/strict'
import childProcess, { type SpawnOptions } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser } from 'playwright-core'
import { ScrapeBrowserHostModule } from './scrapeBrowser'

const fixture = path.resolve('apps/desktop/src/main/scrapers/testFixtures/scrapeBrowserLifecycleHelper.ts')

function createHost(t: TestContext, disconnectDuringStartup = false) {
  // Keep the real process, IPC transport, and CDP HTTP request. Only replace the
  // Chromium CDP client, so this test can also run on workers without a display.
  const context = {
    pages: () => [page],
    on: () => {},
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: 'fixture-page' } }),
      detach: async () => {}
    })
  }
  const page = { on: () => {}, setDefaultTimeout: () => {}, context: () => context }
  t.mock.method(chromium, 'connectOverCDP', async () => ({
    contexts: () => [context],
    on: () => {},
    close: async () => {}
  }) as unknown as Browser)

  const spawn = childProcess.spawn
  const children: Array<{ child: childProcess.ChildProcess; exited: boolean }> = []
  const overlap: boolean[] = []
  const host = new ScrapeBrowserHostModule()
  const acquire = () => host.acquire({
    ownerId: 'lifecycle-fixture',
    purpose: 'scrape',
    signal: new AbortController().signal
  })
  t.mock.method(childProcess, 'spawn', (_executable: string, _args: string[], options: SpawnOptions) => {
    const first = children.length === 0
    overlap.push(children.some(({ exited }) => !exited))
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      ...options,
      env: {
        ...options.env,
        ELECTRON_RUN_AS_NODE: '1',
        JAVDEX_FIXTURE_DISCONNECT_DURING_STARTUP: first && disconnectDuringStartup ? '1' : '0'
      }
    })
    const record = { child, exited: false }
    children.push(record)
    child.once('exit', () => { record.exited = true })
    return child
  })
  syncBuiltinESMExports()

  t.after(async () => {
    try {
      for (const { child, exited } of children) {
        if (!exited) child.kill('SIGKILL')
      }
      await host.dispose()
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })

  return { acquire, overlap }
}

async function beforeDeadline<T>(operation: Promise<T>): Promise<T> {
  const deadline = new AbortController()
  try {
    return await Promise.race([
      operation,
      delay(5_000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('Scraper did not recover within the regression test deadline')
      })
    ])
  } finally {
    deadline.abort()
  }
}

test('retries when startup IPC drops while a CDP request is still pending', async (t) => {
  const { acquire, overlap } = createHost(t, true)

  const lease = await beforeDeadline(acquire())
  assert.equal(await lease.fetchPage('https://example.test/ok'), '<main>fixture</main>')
  assert.deepEqual(overlap, [false, false])
  await lease.release()
})

test('can retry immediately after disconnect without starting a second live helper', async (t) => {
  const { acquire, overlap } = createHost(t)
  const lease = await beforeDeadline(acquire())

  await assert.rejects(
    beforeDeadline(lease.fetchPage('https://example.test/disconnect')),
    /Scraper helper IPC disconnected/
  )
  const replacement = await beforeDeadline(acquire())
  assert.equal(await replacement.fetchPage('https://example.test/ok'), '<main>fixture</main>')
  assert.deepEqual(overlap, [false, false])
  await replacement.release()
})
