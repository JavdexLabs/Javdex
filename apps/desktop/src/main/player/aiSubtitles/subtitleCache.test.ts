import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSubtitleCache, subtitleCacheKey } from './subtitleCache'
import type { PlaybackSource } from '../playbackSource'
import { AI_SUBTITLE_ASSETS } from './runtimeManifest'
import { localTranslationVersion } from './localTranslation'

const source: PlaybackSource = { target: { libraryId: 1, videoId: 2, resourceId: 3 }, title: 'Fixture', mode: 'remote',
  locator: 'https://server.invalid/grant?secret=one', identityKey: 'catalog-A', revision: 'version-A', resumeKey: 'resource-A' }
test('cache identity excludes renewed grant URLs but isolates resource revisions, audio and catalog', () => {
  const first = subtitleCacheKey(source, 'audio1')
  assert.equal(subtitleCacheKey({ ...source, locator: 'https://server.invalid/grant?secret=two' }, 'audio1'), first)
  assert.notEqual(subtitleCacheKey({ ...source, revision: 'version-B' }, 'audio1'), first)
  assert.notEqual(subtitleCacheKey({ ...source, identityKey: 'catalog-B' }, 'audio1'), first)
  assert.notEqual(subtitleCacheKey(source, 'audio2'), first)
  assert.notEqual(subtitleCacheKey(source, 'audio1', 'different-model-sha'), first)
  assert.equal(subtitleCacheKey(source, 'audio1', AI_SUBTITLE_ASSETS.find(asset => asset.id === 'kotoba')!.sha256), first)
})
test('translation precision changes invalidate only the Chinese text and retain recognized Japanese', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-cache-precision-'))
  try {
    const key = subtitleCacheKey(source, 'audio1', 'asr-weight-A')
    const chunk = { index: 0, translated: true, cues: [{ start: 0, end: 2, japanese: 'こんにちは', chinese: '你好' }] }
    await createSubtitleCache(root, key, true, 'qwen-weight-A').write(chunk)
    assert.deepEqual(await createSubtitleCache(root, key, true, 'qwen-weight-A').read(0), chunk)
    assert.deepEqual(await createSubtitleCache(root, key, true, 'qwen-weight-B').read(0), {
      index: 0, translated: false, cues: [{ start: 0, end: 2, japanese: 'こんにちは' }]
    })
    assert.equal(await createSubtitleCache(root, subtitleCacheKey(source, 'audio1', 'asr-weight-B')).read(0), null)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('cache round trips across instances, rejects malformed files and keeps private cues off disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-cache-'))
  try {
    const key = subtitleCacheKey(source, 'audio1'), storage = createSubtitleCache(root, key)
    const chunk = { index: 0, translated: false, cues: [{ start: 0, end: 2, japanese: 'こんにちは' }] }
    await storage.write(chunk)
    assert.deepEqual(await createSubtitleCache(root, key).read(0), chunk)
    const defaultTranslation = AI_SUBTITLE_ASSETS.find(asset => asset.id === 'translation-model')!.sha256
    await storage.write({ ...chunk, translated: true, cues: [{ ...chunk.cues[0], chinese: '你好' }] })
    assert.equal((await createSubtitleCache(root, key, true, defaultTranslation).read(0))?.translated, true)
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

test('changing from Qwen to HY or its precision retains Japanese and invalidates only the Chinese translation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-cache-hy-'))
  try {
    const key = subtitleCacheKey(source, 'audio1'), japanese = { start: 0, end: 2, japanese: 'おはよう' }
    const qwen = localTranslationVersion('qwen3', AI_SUBTITLE_ASSETS.find(asset => asset.id === 'translation-model')!.sha256)
    const hy = localTranslationVersion('hy-mt2-7b', 'hy-q4-hash')
    const chunk = { index: 0, translated: true, cues: [{ ...japanese, chinese: '早上好' }] }
    await createSubtitleCache(root, key, true, qwen).write(chunk)
    assert.deepEqual(await createSubtitleCache(root, key, true, hy).read(0), { index: 0, translated: false, cues: [japanese] })
    await createSubtitleCache(root, key, true, hy).write(chunk)
    assert.deepEqual(await createSubtitleCache(root, key, true, hy).read(0), chunk)
    for (const version of [qwen, localTranslationVersion('hy-mt2-7b', 'hy-q8-hash'), 'hy-new-prompt:hy-q4-hash']) {
      assert.deepEqual(await createSubtitleCache(root, key, true, version).read(0), { index: 0, translated: false, cues: [japanese] })
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Index family, precision and prompt versions isolate Chinese text from Qwen and HY while retaining Japanese', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-cache-index-'))
  try {
    const key = subtitleCacheKey(source, 'audio1'), japanese = { start: 0, end: 2, japanese: 'おはよう' }
    const versions = [localTranslationVersion('qwen3', 'qwen-hash'), localTranslationVersion('hy-mt2-7b', 'hy-hash'),
      localTranslationVersion('index-translate-9b', 'index-q4-hash'), localTranslationVersion('index-translate-9b', 'index-q8-hash'),
      'index-translate-9b-new-prompt:index-q4-hash']
    const chunk = { index: 0, translated: true, cues: [{ ...japanese, chinese: '早上好' }] }
    for (const current of versions) {
      await createSubtitleCache(root, key, true, current).write(chunk)
      for (const target of versions) assert.deepEqual(await createSubtitleCache(root, key, true, target).read(0),
        target === current ? chunk : { index: 0, translated: false, cues: [japanese] })
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
