import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { request } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { getVideoResourceInLibrary } from '@library/db/videoRepo'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { ensureCatalogIdentity } from '@library/catalog/catalogIdentity'
import { grantCatalogPlayback, inspectPlayStream, resourceLocatorRevision, type StoredPlayGrant } from '@library/catalog/catalogPlay'
import { readCatalogSetting, writeCatalogSetting } from '@library/catalog/catalogSettings'
import { createPlaybackBridge } from '@http/playbackBridge'
import { createPlayerService } from '../services/playerService'

const origin = 'https://fixture.invalid'
const read = (url: string): Promise<{ status: number; data: string }> => new Promise((resolve, reject) => {
  request(url, { headers: { Range: 'bytes=0-3' } }, response => {
    let data = ''
    response.on('data', chunk => { data += chunk })
    response.on('end', () => resolve({ status: response.statusCode!, data }))
    response.on('error', reject)
  }).on('error', reject).end()
})

function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-grant-integration-')))
  initDatabaseAtPath(':memory:')
  const identity = ensureCatalogIdentity({ serverId: randomUUID() })
  const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: directory } })
  const inputs = Array.from({ length: 65 }, (_, index) => {
    const filePath = path.join(directory, `电影-${index}.mp4`)
    fs.writeFileSync(filePath, '0123456789')
    const { videoId, fileId } = insertTestVideoWithFile(getDb(), { code: `GRANT-${index}`, filePath, rootId: root.id })
    return { libraryId: 1, videoId, resourceId: fileId, locatorRevision: resourceLocatorRevision(getVideoResourceInLibrary(1, fileId)!) }
  })
  let now = Date.now(), issued = 0
  const issue = (index: number) => {
    issued++
    const grant = grantCatalogPlayback(inputs[index], { deviceId: 'client', now: new Date(++now) })
    return { ...grant, playbackHandle: new URL(grant.playbackHandle, origin).href }
  }
  const inspect = (grantId: string, token: string) => inspectPlayStream({ grantId, token, now: new Date(++now) })
  // Use the real grant store/file guard behind the actual loopback HTTP listener.
  const bridge = createPlaybackBridge(origin, async (url, options) => {
    const target = new URL(url)
    try {
      const inspected = inspect(target.pathname.split('/')[3], target.searchParams.get('t')!)
      const data = fs.readFileSync(inspected.file).subarray(0, 4)
      return new Response(options?.method === 'HEAD' ? null : data, { status: 206,
        headers: { 'Content-Length': '4', 'Content-Range': 'bytes 0-3/10', 'Content-Type': 'video/mp4' } })
    } catch { return new Response(null, { status: 404 }) }
  }, () => now)
  t.after(async () => { await bridge.close(); closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
  const openExternal = async (index: number) => {
    const grant = await bridge.external(String(index), async () => issue(index))
    bridge.finishExternal(grant.playbackHandle, true)
    return grant
  }
  const openInternal = async () => {
    const grant = issue(0)
    return bridge.grant(grant.playbackHandle, grant.expiresAt, { renew: async () => {
      const next = issue(0)
      return { url: next.playbackHandle, expiresAt: next.expiresAt }
    } })
  }
  const count = (): number => (getDb().prepare("SELECT count(*) AS n FROM catalog_settings WHERE key LIKE 'play-grant:%'").get() as { n: number }).n
  return { bridge, inputs, issue, openExternal, openInternal, count, issued: () => issued, identity }
}

test('64 owned and 64 external proxies allow another external handoff without server eviction', async t => {
  const f = fixture(t)
  const native = await f.openInternal()
  for (let i = 1; i < 64; i++) await f.openInternal()
  const external = []
  for (let i = 0; i < 64; i++) external.push(await f.openExternal(i))
  const firstStored = readCatalogSetting<StoredPlayGrant | null>(`play-grant:${external[0].grantId}`, null)
  assert.ok(firstStored)
  const service = createPlayerService({
    catalog: {
      mode: 'remote', identity: f.identity, generation: 1,
      queries: { getResource: async ({ resourceId }: { resourceId: number }) => {
        const resource = getVideoResourceInLibrary(1, resourceId)!
        return { ...resource, locatorRevision: resourceLocatorRevision(resource) }
      } },
      assets: { grantPlayback: () => f.bridge.external('64', async () => f.issue(64)) },
      finishExternalPlayback: (handle: string, opened: boolean) => f.bridge.finishExternal(handle, opened)
    } as never,
    readPlayerPath: async () => '/synthetic/player',
    spawnPlayer: async (_program, [handle]) => {
      assert.deepEqual(await read(handle), { status: 206, data: '0123' })
      return { ok: true }
    }
  })
  assert.deepEqual(await service.openResource(1, f.inputs[64].resourceId, f.inputs[64].videoId, 'external'), { ok: true })
  assert.equal((await read(external[0].playbackHandle)).status, 403, 'only the oldest device-local external URL is evicted')
  assert.deepEqual(await read(native), { status: 206, data: '0123' })
  assert.equal(f.count(), 129, 'the server retains every unexpired grant regardless of the client pool limits')
  assert.deepEqual(readCatalogSetting(`play-grant:${external[0].grantId}`, null), firstStored)
})

test('lost issuance responses preserve old grants; server-expired cache entries recover before external handoff', async t => {
  const f = fixture(t)
  const native = await f.openInternal()
  const external = []
  for (let i = 0; i < 64; i++) external.push(await f.openExternal(i))
  await assert.rejects(f.bridge.external('64', async () => {
    f.issue(64)
    throw new Error('response lost after server commit')
  }))
  const before = f.issued()
  const retained = await f.openExternal(0)
  assert.equal(retained.playbackHandle, external[0].playbackHandle)
  assert.deepEqual(await read(retained.playbackHandle), { status: 206, data: '0123' })
  assert.equal(f.issued(), before)
  const stored = readCatalogSetting<StoredPlayGrant | null>(`play-grant:${retained.grantId}`, null)
  assert.ok(stored)
  writeCatalogSetting(`play-grant:${retained.grantId}`, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() })
  const recovered = await f.openExternal(0)
  assert.notEqual(recovered.playbackHandle, retained.playbackHandle)
  assert.equal(f.issued(), before + 1)
  assert.deepEqual(await read(recovered.playbackHandle), { status: 206, data: '0123' })
  assert.equal((await read(retained.playbackHandle)).status, 403)
  assert.deepEqual(await read(native), { status: 206, data: '0123' })
})
