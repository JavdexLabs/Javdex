import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CatalogBackend } from '../../application/catalogBackend'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { createPlaybackSourceResolver } from '../playbackSource'
import { createBatchSubtitles, suggestedSubtitleAudio } from './batchSubtitles'
import { subtitleOutputPath } from './subtitleFiles'

const track = (index: number, language: string) => ({ index, language, label: language || '未知' })
test('a sole stream is selected regardless of language; multiple streams require one Japanese match', () => {
  for (const language of ['', 'und', 'eng', 'zho', 'jpn']) {
    assert.equal(suggestedSubtitleAudio([track(4, language)]), 4)
  }
  assert.equal(suggestedSubtitleAudio([track(0, 'eng'), track(2, 'jpn')]), 2)
  assert.equal(suggestedSubtitleAudio([track(0, 'ja-JP'), track(2, 'eng')]), 0)
  for (const tracks of [[], [track(0, 'eng'), track(1, 'zho')], [track(1, 'jpn'), track(3, 'ja')], [track(1, ''), track(3, '')]]) {
    assert.equal(suggestedSubtitleAudio(tracks), null)
  }
})

test('batch preview and commit use scoped identities, recheck files and tracks, and isolate per-film failures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-batch-subtitles-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  function resource(id: number, video: number, name: string, primary = false, kind = 'local') {
    const locator = path.join(root, name)
    return { id, library_id: 1, video_id: video, kind, is_primary: Number(primary), root_id: null, locator, display_locator: locator }
  }
  const resources = [resource(10, 1, 'missing.mp4', true), resource(11, 1, 'disc-a.mp4'), resource(12, 1, 'disc-b.mp4'),
    resource(20, 2, 'second.mp4', true), resource(21, 2, 'alternate.mp4'), resource(30, 3, 'link.strm', true, 'url')]
  for (const row of resources.filter(r => [11, 12, 20, 21].includes(r.id))) await fs.writeFile(row.locator, 'fixture')
  const backend = { mode: 'local', generation: 1, identity: { mode: 'local', catalogId: 'test' },
    session: () => ({ state: 'available', writerEpoch: 1 }), libraries: { get: async () => ({ status: 'active' }) },
    queries: {
      getVideo: async ({ scope, videoId }: { scope: { libraryId: number }; videoId: number }) => {
        assert.equal(scope.libraryId, 1)
        return { id: videoId, code: 'CODE-' + videoId, resources: resources.filter(r => r.video_id === videoId) }
      },
      getResource: async ({ resourceId }: { resourceId: number }) => resources.find(r => r.id === resourceId)
    }
  }
  const catalog = backend as unknown as CatalogBackend
  const enqueued: string[] = []
  let leases = 0
  let mediaAudio = [track(1, 'eng'), track(2, 'jpn')]
  const service = createBatchSubtitles({ backend: catalog, resolver: createPlaybackSourceResolver(catalog),
    paths: () => ({ asrVersion: 'a', translationVersion: 't' }) as AiRuntimePaths,
    acquire: async () => { leases++; return () => { leases-- } },
    inspectMedia: async () => { assert.equal(leases, 1); return { duration: 10, audio: mediaAudio } },
    queue: { matchingJobs: async () => [], enqueueBatchItem: async (_s, _audio, _dur, _out, title) => {
      assert.equal(leases, 1)
      enqueued.push(title)
      return { id: 'test', outcome: 'queued', message: '已加入队列' }
    } }
  })
  const ctx = await service.start()
  const preview = (videoId: number, resourceId: number | null = null) => service.preview(ctx, 1, videoId, resourceId)
  assert.equal((await preview(1)).resourceId, null)
  const selected = await preview(1, 12)
  assert.equal(selected.suggestedAudio, 2)
  assert.equal((await preview(1, 99)).resourceId, null)
  assert.match((await preview(3)).error ?? '', /本地视频/)
  const primary = await preview(2)
  assert.equal(primary.resourceId, 20)
  const first = { videoId: 1, resourceId: 12, signature: selected.signature, audioIndex: 2 }
  const second = { videoId: 2, resourceId: 20, signature: primary.signature, audioIndex: 2 }
  await fs.appendFile(resources[2].locator, 'replaced')
  const results = await service.submit(ctx, 1, 'bilingual', [first, second])
  assert.deepEqual(results.map(r => r.outcome), ['failed', 'queued'])
  assert.match(results[0].message, /文件已变化/)
  assert.deepEqual(enqueued, ['CODE-2 · second.mp4'])
  mediaAudio = [track(1, 'jpn')]
  assert.match((await service.submit(ctx, 1, 'japanese', [second]))[0].message, /音轨已变化/)
  await fs.writeFile(subtitleOutputPath(resources[3].locator, 'japanese'), 'existing')
  const existing = (await preview(2)).existingFiles.japanese
  assert.equal(existing?.name, 'second.ja.ai.ass')
  assert.ok(existing?.revision)
  assert.equal((await service.submit(ctx, 1, 'japanese', [second]))[0].outcome, 'skipped')
  const replace = { ...second, audioIndex: 1, replaceRevision: existing.revision }
  assert.equal((await service.submit(ctx, 1, 'japanese', [replace]))[0].outcome, 'queued')
  await fs.appendFile(subtitleOutputPath(resources[3].locator, 'japanese'), 'edited')
  assert.match((await service.submit(ctx, 1, 'japanese', [replace]))[0].message, /原字幕已变化/)
  assert.match((await service.submit(ctx, 1, 'bilingual', [replace]))[0].message, /原字幕已变化/)
  await fs.unlink(resources[1].locator)
  assert.equal((await preview(1)).resourceId, 12)
  backend.generation++
  await assert.rejects(preview(2), /已切换/)
  backend.mode = 'remote'
  await assert.rejects(service.start(), /本机资料库/)
  assert.equal(leases, 0)
})
