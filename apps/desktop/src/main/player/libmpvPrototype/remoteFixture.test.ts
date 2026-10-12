import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { resolveLibraryUserDataPath } from '@library/runtime/host'
import { readCatalogSetting, writeCatalogSetting } from '@library/catalog/catalogSettings'
import { createRemotePlaybackFixture, type RemotePlaybackFixture } from './remoteFixture'

it('serves real authenticated Range streams without touching the parent catalog', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-remote-fixture-test-'))
  const parent = initDatabaseAtPath(path.join(root, 'parent-sentinel.db'))
  writeCatalogSetting('fixture-parent-sentinel', 'untouched', parent)
  const parentUserData = resolveLibraryUserDataPath()
  const mediaDir = path.join(root, '媒体')
  fs.mkdirSync(mediaDir)
  const media = path.join(mediaDir, '片段 one.mp4')
  // Transport-only payload. Successful HTTP checks do not imply media decoding.
  const payload = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))
  fs.writeFileSync(media, payload)
  const marker = path.join(root, 'caller-owned.txt')
  fs.writeFileSync(marker, 'do not delete')
  let first: RemotePlaybackFixture | undefined
  let second: RemotePlaybackFixture | undefined
  try {
    first = await createRemotePlaybackFixture(root, [media, media])
    second = await createRemotePlaybackFixture(root, [media])
    assert.notEqual(first.directory, second.directory)
    assert.equal(getDb(), parent)
    assert.equal(resolveLibraryUserDataPath(), parentUserData)
    assert.equal(readCatalogSetting('fixture-parent-sentinel', null, parent), 'untouched')
    assert.deepEqual(await first.stats().then((stats) => stats.checks), {
      missingBearer: 401, wrongBearer: 401, missingPlayToken: 404, wrongPlayToken: 404,
      head: 200, range: 206, bytesMatch: true
    })
    const source = first.getSource(0)
    assert.equal(source.label, path.basename(media))
    assert.equal(source.label.includes(root), false)
    assert.throws(() => first!.getSource(-1), /index/)
    assert.throws(() => first!.getSource(2), /index/)
    assert.throws(() => first!.getSource(0.5), /index/)
    const baseline = await first.stats()
    const response = await fetch(source.playbackHandle, {
      headers: { Range: 'bytes=100-199' }, signal: AbortSignal.timeout(5_000)
    })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 100-199/${payload.length}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(100, 200))
    const after = await first.stats()
    assert.equal(after.requests - baseline.requests, 1)
    assert.equal(after.rangeRequests - baseline.rangeRequests, 1)
    assert.equal(after.partialResponses - baseline.partialResponses, 1)
    assert.equal(after.rangeBytes - baseline.rangeBytes, 100)
    assert.equal(after.mediaBytes - baseline.mediaBytes, 100)
    const secondSource = first.getSource(1)
    const full = await fetch(secondSource.playbackHandle, { signal: AbortSignal.timeout(5_000) })
    assert.equal(full.status, 200)
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload)
    const invalid = new URL(source.playbackHandle)
    invalid.searchParams.set('t', 'not-a-play-token')
    const rejected = await fetch(invalid, { signal: AbortSignal.timeout(5_000) })
    assert.equal(rejected.status, 404)
    await rejected.arrayBuffer()
    assert.equal((await first.stats()).rejected404, baseline.rejected404 + 1)
    const originalDirectory = first.directory
    await Promise.all([first.close(), first.close()])
    assert.throws(() => first!.getSource(0), /closed/)
    assert.equal((await first.stats()).activeRequests, 0)
    assert.equal(fs.existsSync(path.join(originalDirectory, 'library.db')), true)
    await assert.rejects(fetch(source.playbackHandle, { signal: AbortSignal.timeout(2_000) }))
    // WebServer.stop closes all streams only in its own isolated library runtime.
    const survivor = await fetch(second.getSource(0).playbackHandle, {
      headers: { Range: 'bytes=0-7' }, signal: AbortSignal.timeout(5_000)
    })
    assert.equal(survivor.status, 206)
    assert.deepEqual(Buffer.from(await survivor.arrayBuffer()), payload.subarray(0, 8))
    await second.close()
    assert.equal(getDb(), parent)
    assert.equal(fs.readFileSync(marker, 'utf8'), 'do not delete')
    assert.deepEqual(fs.readFileSync(media), payload)
    await assert.rejects(createRemotePlaybackFixture('relative', [media]), /absolute/)
    await assert.rejects(createRemotePlaybackFixture(root, []), /at least one/)
  } finally {
    await Promise.all([first?.close(), second?.close()])
    closeDatabase()
    // Only this test's mkdtemp tree is deleted, never a supplied media directory.
    fs.rmSync(root, { recursive: true, force: true })
  }
})
