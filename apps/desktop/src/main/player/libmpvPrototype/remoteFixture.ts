import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'

export interface RemotePlaybackSource {
  /** Main-process only: this URL contains a resource-scoped playback token. */
  playbackHandle: string
  label: string
}

export interface RemotePlaybackFixtureStats {
  requests: number
  playRequests: number
  rangeRequests: number
  partialResponses: number
  /** Response body bytes queued by the real server, excluding HTTP headers. */
  bytes: number
  /** Successful playback body bytes only; not proof of decoding or consumption. */
  mediaBytes: number
  /** Successful /play/v1 206 body bytes; includes startup Range probes. */
  rangeBytes: number
  rejected401: number
  rejected404: number
  abortedResponses: number
  activeRequests: number
  /** Counts after startup probes; subtract to measure the player's own traffic. */
  startup: { requests: number; playRequests: number; rangeRequests: number; mediaBytes: number; rangeBytes: number }
  checks: {
    missingBearer: number
    wrongBearer: number
    missingPlayToken: number
    wrongPlayToken: number
    head: number
    range: number
    bytesMatch: boolean
  }
}

export interface RemotePlaybackFixture {
  /** Fresh fixture directory under tempRoot. close() intentionally preserves it. */
  directory: string
  getSource(index: number): RemotePlaybackSource
  stats(): Promise<RemotePlaybackFixtureStats>
  close(): Promise<void>
}

type WorkerReply =
  | { kind: 'ready'; sources: RemotePlaybackSource[]; stats: RemotePlaybackFixtureStats }
  | { kind: 'reply'; id: number; stats: RemotePlaybackFixtureStats }
  | { kind: 'error'; message: string }

/**
 * Repository-only fixture; run the esbuild prototype from the repository root.
 * A separate Worker owns the library globals, DB, HTTP server and grant listener.
 * Uses production WebServer/manage/catalog/play, not startJavdexServer: therefore
 * this does not certify independent Node deployment, query workers or scheduling.
 */
export async function createRemotePlaybackFixture(
  tempRoot: string,
  mediaFiles: string[]
): Promise<RemotePlaybackFixture> {
  if (!path.isAbsolute(tempRoot)) throw new Error('Fixture tempRoot must be absolute')
  if (mediaFiles.length === 0) throw new Error('Fixture requires at least one media file')
  const files = mediaFiles.map((file) => {
    if (!path.isAbsolute(file)) throw new Error('Fixture media paths must be absolute')
    const real = fs.realpathSync.native(file)
    const stat = fs.statSync(real)
    if (!stat.isFile() || stat.size === 0) throw new Error('Fixture media must be nonempty files')
    return real
  })
  const repository = process.cwd()
  const entry = path.join(repository, 'apps/desktop/src/main/player/libmpvPrototype/remoteFixtureWorker.ts')
  if (!fs.existsSync(entry)) throw new Error('Run the libmpv prototype from the repository root')
  const metadata = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')) as { version: string }
  fs.mkdirSync(tempRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tempRoot, 'javdex-remote-playback-'))
  fs.chmodSync(directory, 0o700)
  const workerEntry = path.join(directory, 'fixture.cjs')
  // manageDispatch uses the real version guard; its bundled appVersion reads here.
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: metadata.version }), { mode: 0o600 })
  await build({
    entryPoints: [entry], outfile: workerEntry, bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', absWorkingDir: repository,
    alias: {
      '@shared': path.join(repository, 'packages/contracts/src'),
      '@library': path.join(repository, 'packages/library/src'),
      '@http': path.join(repository, 'packages/http/src')
    },
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(workerEntry).href) },
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(path.join(repository, 'package.json'))});` },
    logLevel: 'silent'
  })
  // Never SHARE_ENV: inherited test paths/hooks must not select a formal catalog.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('JAVDEX_TEST_')))
  env.JAVDEX_TEST_USER_DATA = directory
  const worker = new Worker(workerEntry, { workerData: { directory, files }, env })
  let sources: RemotePlaybackSource[] = []
  let snapshot: RemotePlaybackFixtureStats
  let nextId = 0
  let closed = false
  let closing: Promise<void> | undefined
  const pending = new Map<number, {
    resolve: (stats: RemotePlaybackFixtureStats) => void
    reject: (error: Error) => void
  }>()
  let failStartup: (error: Error) => void = () => {}
  const fail = (error: Error): void => {
    closed = true
    failStartup(error)
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', (code) => {
    if (!closed) fail(new Error(`Remote fixture worker exited unexpectedly (${code})`))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Remote fixture startup timed out')), 60_000)
      failStartup = (error) => { clearTimeout(timer); reject(error) }
      worker.on('message', (reply: WorkerReply) => {
        if (reply.kind === 'error') {
          fail(new Error(reply.message))
        } else if (reply.kind === 'ready') {
          clearTimeout(timer)
          sources = reply.sources
          snapshot = reply.stats
          resolve()
        } else {
          snapshot = reply.stats
          pending.get(reply.id)?.resolve(reply.stats)
          pending.delete(reply.id)
        }
      })
    })
  } catch (error) {
    closed = true
    await worker.terminate()
    throw error
  }
  const request = (command: 'stats' | 'close'): Promise<RemotePlaybackFixtureStats> => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Remote fixture ${command} timed out`))
      }, 10_000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      worker.postMessage({ id, command })
    })
  }
  return {
    directory,
    getSource(index) {
      if (closed || closing) throw new Error('Remote fixture is closed')
      if (!Number.isInteger(index) || !sources[index]) throw new Error('Invalid fixture source index')
      return { ...sources[index] }
    },
    async stats() {
      if (closed || closing) return structuredClone(snapshot)
      return request('stats')
    },
    close() {
      if (closing) return closing
      closing = (async () => {
        try {
          if (!closed) snapshot = await request('close')
        } finally {
          closed = true
          await worker.terminate()
          fail(new Error('Remote fixture is closed'))
        }
      })()
      return closing
    }
  }
}
