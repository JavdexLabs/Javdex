import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSubtitleCache, subtitleCacheKey } from './subtitleCache'
import type { PlaybackSource } from '../playbackSource'

const source: PlaybackSource = { target: { libraryId: 1, videoId: 2, resourceId: 3 }, title: 'Fixture', mode: 'remote',
  locator: 'https://server.invalid/grant?secret=one', identityKey: 'catalog-A', revision: 'version-A', resumeKey: 'resource-A' }
test('cache identity excludes renewed grant URLs but isolates resource revisions, audio and catalog', () => {
  const first = subtitleCacheKey(source, 'audio1')
  assert.equal(subtitleCacheKey({ ...source, locator: 'https://server.invalid/grant?secret=two' }, 'audio1'), first)
  assert.notEqual(subtitleCacheKey({ ...source, revision: 'version-B' }, 'audio1'), first)
  assert.notEqual(subtitleCacheKey({ ...source, identityKey: 'catalog-B' }, 'audio1'), first)
  assert.notEqual(subtitleCacheKey(source, 'audio2'), first)
})
test('cache round trips across instances, rejects malformed files and keeps private cues off disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-cache-'))
  try {
    const key = subtitleCacheKey(source, 'audio1'), storage = createSubtitleCache(root, key)
    const chunk = { index: 0, translated: false, cues: [{ start: 0, end: 2, japanese: 'こんにちは' }] }
    await storage.write(chunk)
    assert.deepEqual(await createSubtitleCache(root, key).read(0), chunk)
    await fs.writeFile(path.join(storage.directory, '2.json'), JSON.stringify({ version: 1, index: 2, translated: true,
      translationVersion: 'old-model', cues: [{ start: 60, end: 62, japanese: 'はい', chinese: '旧译文' }] }))
    assert.deepEqual(await createSubtitleCache(root, key).read(2), { index: 2, translated: false, cues: [{ start: 60, end: 62, japanese: 'はい' }] })
    await fs.writeFile(path.join(storage.directory, '1.json'), '{"secret":"untrusted"}')
    assert.equal(await createSubtitleCache(root, key).read(1), null)
    const privateKey = subtitleCacheKey(source, 'private'), privateStorage = createSubtitleCache(root, privateKey, false)
    await privateStorage.write(chunk); assert.deepEqual(await privateStorage.read(0), chunk)
    assert.equal(await fs.access(privateStorage.directory).then(() => true, () => false), false)
    await storage.clear(); assert.equal(await storage.read(0), null)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
