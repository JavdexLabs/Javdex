import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ScraperResourceCache } from './scraperResourceCache'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scraper-cache-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('ScraperResourceCache', () => {
  it('reuses a fresh plugin resource without another network request', async () => {
    let now = 1_000
    let requests = 0
    const cache = new ScraperResourceCache({
      rootDir: makeTempDir(),
      now: () => now
    })
    const request = {
      kind: 'actress' as const,
      pluginName: 'Gfriends',
      url: 'https://example.com/Filetree.json',
      maxAgeMs: 60_000,
      staleIfError: true
    }
    const fetcher = async () => {
      requests += 1
      return {
        statusCode: 200,
        body: Buffer.from('version-one'),
        etag: '"v1"'
      }
    }

    assert.equal((await cache.fetch(request, fetcher)).toString(), 'version-one')
    now += 30_000
    assert.equal((await cache.fetch(request, fetcher)).toString(), 'version-one')
    assert.equal(requests, 1)
  })

  it('reuses a fresh plugin resource after the cache is recreated', async () => {
    const rootDir = makeTempDir()
    const request = {
      kind: 'actress' as const,
      pluginName: 'Gfriends',
      url: 'https://example.com/Filetree.json',
      maxAgeMs: 60_000,
      staleIfError: true
    }
    const first = new ScraperResourceCache({ rootDir, now: () => 1_000 })
    await first.fetch(request, async () => ({
      statusCode: 200,
      body: Buffer.from('persisted'),
      etag: '"v1"'
    }))

    const recreated = new ScraperResourceCache({ rootDir, now: () => 31_000 })
    const body = await recreated.fetch(request, async () => {
      throw new Error('network should not be called')
    })

    assert.equal(body.toString(), 'persisted')
  })

  it('revalidates an expired resource with its ETag and retains a 304 body', async () => {
    const rootDir = makeTempDir()
    let now = 1_000
    const request = {
      kind: 'actress' as const,
      pluginName: 'Gfriends',
      url: 'https://example.com/Filetree.json',
      maxAgeMs: 60_000,
      staleIfError: true
    }
    const cache = new ScraperResourceCache({ rootDir, now: () => now })
    await cache.fetch(request, async () => ({
      statusCode: 200,
      body: Buffer.from('version-one'),
      etag: '"v1"'
    }))

    now = 62_000
    const revalidated = await cache.fetch(request, async (_url, headers) => {
      assert.equal(headers['If-None-Match'], '"v1"')
      return { statusCode: 304, body: Buffer.alloc(0) }
    })
    assert.equal(revalidated.toString(), 'version-one')

    now = 70_000
    const recreated = new ScraperResourceCache({ rootDir, now: () => now })
    const fresh = await recreated.fetch(request, async () => {
      throw new Error('revalidated resource should still be fresh')
    })
    assert.equal(fresh.toString(), 'version-one')
  })

  it('returns an expired resource when revalidation fails and stale fallback is enabled', async () => {
    let now = 1_000
    const cache = new ScraperResourceCache({
      rootDir: makeTempDir(),
      now: () => now
    })
    const request = {
      kind: 'actress' as const,
      pluginName: 'Gfriends',
      url: 'https://example.com/Filetree.json',
      maxAgeMs: 60_000,
      staleIfError: true
    }
    await cache.fetch(request, async () => ({
      statusCode: 200,
      body: Buffer.from('last-good'),
      etag: '"v1"'
    }))

    now = 62_000
    const body = await cache.fetch(request, async () => {
      throw new Error('offline')
    })

    assert.equal(body.toString(), 'last-good')
  })

  it('rejects a resource larger than the host entry quota', async () => {
    const cache = new ScraperResourceCache({
      rootDir: makeTempDir(),
      maxEntryBytes: 4
    })

    await assert.rejects(
      cache.fetch(
        {
          kind: 'actress',
          pluginName: 'large-resource',
          url: 'https://example.com/large.bin',
          maxAgeMs: 60_000,
          staleIfError: false
        },
        async () => ({
          statusCode: 200,
          body: Buffer.from('12345')
        })
      ),
      /exceeds the persistent cache entry limit/
    )
  })

  it('rejects writes beyond the host quota for one plugin', async () => {
    const cache = new ScraperResourceCache({
      rootDir: makeTempDir(),
      maxEntryBytes: 4,
      maxPluginBytes: 5
    })
    const baseRequest = {
      kind: 'actress' as const,
      pluginName: 'bounded-plugin',
      maxAgeMs: 60_000,
      staleIfError: false
    }
    await cache.fetch(
      { ...baseRequest, url: 'https://example.com/a.bin' },
      async () => ({ statusCode: 200, body: Buffer.from('123') })
    )

    await assert.rejects(
      cache.fetch(
        { ...baseRequest, url: 'https://example.com/b.bin' },
        async () => ({ statusCode: 200, body: Buffer.from('456') })
      ),
      /exceeds the persistent cache plugin limit/
    )
  })

  it('enforces the plugin quota across concurrent resource commits', async () => {
    const rootDir = makeTempDir()
    const cache = new ScraperResourceCache({
      rootDir,
      maxEntryBytes: 4,
      maxPluginBytes: 5
    })
    const baseRequest = {
      kind: 'actress' as const,
      pluginName: 'concurrent-plugin',
      maxAgeMs: 60_000,
      staleIfError: false
    }
    const outcomes = await Promise.allSettled([
      cache.fetch(
        { ...baseRequest, url: 'https://example.com/a.bin' },
        async () => ({ statusCode: 200, body: Buffer.from('123') })
      ),
      cache.fetch(
        { ...baseRequest, url: 'https://example.com/b.bin' },
        async () => ({ statusCode: 200, body: Buffer.from('456') })
      )
    ])

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
    const bodyBytes = fs
      .readdirSync(path.join(rootDir, fs.readdirSync(rootDir)[0]))
      .filter((name) => name.endsWith('.bin'))
      .reduce(
        (total, name) =>
          total + fs.statSync(path.join(rootDir, fs.readdirSync(rootDir)[0], name)).size,
        0
      )
    assert.ok(bodyBytes <= 5)
  })
})
