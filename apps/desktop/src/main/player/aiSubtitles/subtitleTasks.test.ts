import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSubtitleTasks } from './subtitleTasks'
import type { PlaybackSource } from '../playbackSource'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import type { createOfflineSubtitleInference } from './offlineInference'
import { subtitleOutputPath, publishSubtitleFile, discoverSubtitleFiles, inspectSubtitleOutput } from './subtitleFiles'
import { createBackgroundSubtitleDisplay } from './backgroundSubtitleDisplay'
import { renderSubtitleAss } from './subtitleDocument'
import type { AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback } from '../nativePlayback'

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10) }
  assert.fail('subtitle task did not reach expected state')
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-subtitle-tasks-'))
  const source: PlaybackSource = { title: 'fixture', target: { libraryId: 1, videoId: 2, resourceId: 3 },
    mode: 'local', locator: path.join(root, 'ABC-123.mp4'), identityKey: 'catalog', revision: '1', resumeKey: 'file-v1', fileIdentity: 'physical-v1' }
  await fs.writeFile(source.locator, 'fixture')
  let recognizes = 0, translations = 0, leases = 0, changed = false, failTranslation = false
  let recognizeWait = async (signal: AbortSignal): Promise<void> => { signal.throwIfAborted() }
  const paths = { asrVersion: 'asr1', translationVersion: 'tr1', kotoba: 'kotoba', translationModel: 'translation' } as AiRuntimePaths
  const dependencies = { root: path.join(root, 'tasks'), cacheRoot: path.join(root, 'old-cache'),
    resolve: async () => ({ ...source, ...(changed ? { resumeKey: 'new-file' } : {}) }),
    validate: async () => { if (changed) throw new Error('resource changed') },
    runtime: { installed: async () => true, paths: () => paths },
    acquireRuntime: async () => { leases++; return () => { leases-- } },
    inference: (() => ({
      probe: async () => ({ index: 1, identity: 'audio1' }),
      recognize: async (_locator: string, _index: number, start: number, end: number, signal: AbortSignal) => {
        recognizes++; await recognizeWait(signal); return [{ start, end, japanese: '原文' }]
      },
      translate: async cues => { translations++; if (failTranslation) throw new Error('translation failed'); return cues.map(cue => ({ ...cue, chinese: '译文' })) },
      close: async () => {}, translateText: async () => ''
    })) as typeof createOfflineSubtitleInference }
  let jobs = createSubtitleTasks(dependencies)
  return { root, source, paths, get jobs() { return jobs }, recognizes: () => recognizes, translations: () => translations, leases: () => leases,
    waitRecognition: (fn: typeof recognizeWait) => { recognizeWait = fn }, failTranslation: (value: boolean) => { failTranslation = value },
    changeSource: () => { changed = true }, restart: async (beforeOpen?: () => Promise<void>) => {
      await jobs.close(); await beforeOpen?.(); jobs = createSubtitleTasks(dependencies); await jobs.ready
    },
    cleanup: async () => { await jobs.close(); await fs.rm(root, { recursive: true, force: true }) } }
}

test('batch joins the device queue exactly once, respects user pauses and never replaces an existing sidecar', async () => {
  const f = await fixture()
  try {
    f.jobs.observe(true, null, 0)
    const add = (resumeId?: string) => f.jobs.enqueueBatchItem(f.source, 1, 42, 'bilingual', 'ABC-123 · ABC-123.mp4', resumeId)
    const destination = subtitleOutputPath(f.source.locator, 'bilingual')
    await fs.writeFile(destination, 'user-owned')
    assert.equal((await add()).outcome, 'skipped')
    assert.equal((await f.jobs.snapshot()).tasks.length, 0)
    assert.equal(await fs.readFile(destination, 'utf8'), 'user-owned')
    await fs.unlink(destination)
    await fs.writeFile(path.join(f.root, 'ABC-123.zh.srt'), 'existing translation')
    const [first, duplicate] = await Promise.all([add(), add()])
    assert.equal(first.outcome, 'queued')
    assert.equal(duplicate.outcome, 'skipped')
    assert.equal(await f.jobs.enqueue(f.source, 1, 42), first.id)
    assert.equal((await f.jobs.snapshot()).tasks.length, 1)
    const [job] = await f.jobs.matchingJobs(f.source)
    assert.equal(job.status, 'queued')
    await f.jobs.action(job.id, 'pause')
    assert.equal((await add()).outcome, 'skipped')
    assert.equal((await add('stale-id')).outcome, 'skipped')
    assert.equal((await add(job.id)).outcome, 'resumed')
    await f.jobs.action(job.id, 'remove')
    assert.equal((await add(job.id)).outcome, 'skipped')
    assert.deepEqual(await f.jobs.matchingJobs(f.source), [])
    assert.equal(f.recognizes(), 0)
  } finally { await f.cleanup() }
})

test('bulk shortcuts stop the active worker, respect changed states and keep published subtitles on clear', async t => {
  const f = await fixture()
  try {
    const file = subtitleOutputPath(f.source.locator, 'japanese')
    let finishSave!: () => void
    const saving = new Promise<void>(resolve => { finishSave = resolve })
    const link = fs.link
    t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
      if (args[1] === file) await saving
      return link(...args)
    })
    const saved = await f.jobs.enqueue(f.source, 1, 15, 'japanese')
    try {
      await until(() => f.jobs.state(saved)?.job.status === 'saving')
      await f.jobs.bulkAction('remove-active', [saved])
      await f.jobs.bulkAction('clear-completed', [saved])
      await assert.rejects(f.jobs.action(saved, 'remove'), /字幕正在保存/)
    } finally { finishSave() }
    await until(() => f.jobs.state(saved)?.job.status === 'completed' && f.leases() === 0)
    const original = await fs.readFile(file, 'utf8')
    f.jobs.observe(true, null, 0)
    const running = await f.jobs.enqueue(f.source, 1, 60)
    const waiting = await f.jobs.enqueue(f.source, 2, 60)
    f.waitRecognition(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    f.jobs.observe(false, null, 0)
    await until(() => f.jobs.state(running)?.job.status === 'running' && f.leases() === 1)
    const both = [running, waiting]
    const states = () => both.map(id => f.jobs.state(id)?.job.status)
    await f.jobs.bulkAction('pause', [saved, ...both])
    assert.deepEqual(states(), ['paused', 'paused'])
    assert.equal(f.leases(), 0)
    f.jobs.observe(true, null, 0)
    const later = await f.jobs.enqueue(f.source, 3, 60)
    await f.jobs.bulkAction('resume', both)
    assert.deepEqual(states(), ['queued', 'queued'])
    f.jobs.observe(true, running, 0)
    await until(() => f.jobs.state(running)?.job.status === 'running' && f.leases() === 1)
    await f.jobs.bulkAction('remove-active', [saved, ...both])
    assert.equal(f.leases(), 0)
    assert.deepEqual(states(), [undefined, undefined])
    assert.equal(f.jobs.state(saved)?.job.status, 'completed')
    assert.equal(f.jobs.state(later)?.job.status, 'queued')
    await f.jobs.bulkAction('clear-completed', [saved, later])
    assert.equal(f.jobs.state(saved), null)
    await f.restart(async () => {
      const filename = path.join(f.root, 'tasks', 'tasks.json')
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
      assert.deepEqual(manifest.jobs.map((job: { id: string }) => job.id), [later])
      Object.assign(manifest.jobs[0], { status: 'cancelled', recognizedSeconds: 30 })
      await fs.writeFile(filename, JSON.stringify(manifest))
    })
    assert.equal(f.jobs.state(later)?.job.status, 'paused')
    assert.equal(f.jobs.state(later)?.job.recognizedSeconds, 30)
    assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally { await f.cleanup() }
})

test('explicit regeneration from a completed job recognizes and translates again, preserving its destination until success', async () => {
  const f = await fixture()
  try {
    const original = await f.jobs.enqueue(f.source, 1, 15)
    await until(() => f.jobs.state(original)?.job.status === 'completed' && f.leases() === 0)
    const japanese = await f.jobs.enqueue(f.source, 1, 15, 'japanese')
    await until(() => f.jobs.state(japanese)?.job.status === 'completed' && f.leases() === 0)
    assert.equal(f.recognizes(), 1, 'ordinary jobs can share the original recognition')
    const dest = subtitleOutputPath(f.source.locator, 'bilingual')
    await fs.writeFile(dest, 'previous edit')
    const revision = (await inspectSubtitleOutput(dest))?.revision
    assert.ok(revision)
    f.jobs.observe(true, null, 0)
    const add = () => f.jobs.enqueueBatchItem(f.source, 1, 15, 'bilingual', 'fixture', undefined, revision)
    const [first, duplicate] = await Promise.all([add(), add()])
    assert.equal(first.outcome, 'queued'); assert.equal(duplicate.outcome, 'skipped')
    assert.deepEqual((await f.jobs.snapshot()).tasks.map(job => job.id), [japanese, first.id])
    const id = first.id!
    assert.notEqual(id, original)
    await f.restart()
    assert.equal(f.jobs.state(id)?.job.status, 'paused')
    f.failTranslation(true)
    await f.jobs.action(id, 'resume')
    await until(() => f.jobs.state(id)?.job.status === 'failed' && f.leases() === 0)
    assert.equal(await fs.readFile(dest, 'utf8'), 'previous edit')
    assert.equal(f.recognizes(), 2)
    f.failTranslation(false)
    await f.jobs.action(id, 'resume')
    await until(() => f.jobs.state(id)?.job.status === 'completed')
    assert.match(await fs.readFile(dest, 'utf8'), /译文/)
    assert.equal(f.recognizes(), 2)
    assert.equal(f.translations(), 3)
    await assert.rejects(add(), /覆盖目标已变化/)
  } finally { await f.cleanup() }
})

test('replacing from another audio track transfers ownership even when the output bytes match', async () => {
  const f = await fixture()
  try {
    const old = await f.jobs.enqueue(f.source, 1, 15, 'japanese')
    await until(() => f.jobs.state(old)?.job.status === 'completed' && f.leases() === 0)
    const dest = subtitleOutputPath(f.source.locator, 'japanese')
    const previous = await fs.readFile(dest, 'utf8')
    const revision = (await inspectSubtitleOutput(dest))?.revision
    assert.ok(revision)
    const next = await f.jobs.enqueue(f.source, 2, 15, 'japanese', revision)
    await until(() => f.jobs.state(next)?.job.status === 'completed')
    assert.equal(f.jobs.state(old)?.job.outputName, null)
    await assert.rejects(f.jobs.action(old, 'delete-output'), /没有已保存的字幕/)
    assert.equal(await fs.readFile(dest, 'utf8'), previous)
  } finally { await f.cleanup() }
})

test('an edit during generation goes to awaiting-save; retry never overwrites the edit without new consent', async () => {
  const f = await fixture()
  try {
    const dest = subtitleOutputPath(f.source.locator, 'japanese')
    await fs.writeFile(dest, 'old subtitles')
    const revision = (await inspectSubtitleOutput(dest))?.revision
    assert.ok(revision)
    f.jobs.observe(true, null, 0)
    const id = await f.jobs.enqueue(f.source, 1, 15, 'japanese', revision)
    await fs.writeFile(dest, 'edited after submission')
    f.jobs.observe(false, null, 0)
    await until(() => f.jobs.state(id)?.job.status === 'awaiting-save')
    await assert.rejects(f.jobs.action(id, 'retry-save'), /原字幕已变化/)
    assert.equal(await fs.readFile(dest, 'utf8'), 'edited after submission')
    const copy = path.join(f.root, 'saved-as.ass')
    await f.jobs.action(id, 'retry-save', { filename: copy, replace: false })
    assert.match(await fs.readFile(copy, 'utf8'), /原文/)
    assert.equal(await fs.readFile(dest, 'utf8'), 'edited after submission')
  } finally { await f.cleanup() }
})

test('finished bilingual jobs publish beside media, deduplicate, survive restart and task removal keeps output', async () => {
  const f = await fixture()
  try {
    const id = await f.jobs.enqueue(f.source, 1, 60)
    await until(() => f.jobs.state(id)?.job.status === 'completed' && f.leases() === 0)
    const filename = subtitleOutputPath(f.source.locator, 'bilingual')
    assert.match(await fs.readFile(filename, 'utf8'), /译文\\N/)
    assert.equal(await f.jobs.enqueue(f.source, 1, 60), id)
    assert.equal(f.recognizes(), 2)
    await f.restart()
    assert.equal((await f.jobs.snapshot()).tasks[0].status, 'completed')
    await f.jobs.action(id, 'remove')
    assert.match(await fs.readFile(filename, 'utf8'), /原文/)
    await assert.rejects(fs.stat(path.join(f.root, 'tasks', id)), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('a byte-identical existing sidecar stays user-owned and save retry reuses recognition', async () => {
  const f = await fixture()
  try {
    const filename = subtitleOutputPath(f.source.locator, 'bilingual')
    const existing = renderSubtitleAss([{ start: 0, end: 15, japanese: '原文', chinese: '译文' }], 'bilingual')
    await fs.writeFile(filename, existing)
    const id = await f.jobs.enqueue(f.source, 1, 15)
    await until(() => f.jobs.state(id)?.job.status === 'awaiting-save' && f.leases() === 0)
    assert.equal(await fs.readFile(filename, 'utf8'), existing)
    await assert.rejects(f.jobs.action(id, 'delete-output'), /没有已保存的字幕/)
    assert.equal(await fs.readFile(filename, 'utf8'), existing)
    await fs.unlink(filename)
    await f.jobs.action(id, 'retry-save')
    assert.equal(f.jobs.state(id)?.job.status, 'completed')
    assert.equal(f.recognizes(), 1)
    await fs.writeFile(filename, 'user edited')
    await assert.rejects(f.jobs.action(id, 'delete-output'), /外部修改/)
    assert.equal(await fs.readFile(filename, 'utf8'), 'user edited')
  } finally { await f.cleanup() }
})

test('failed translation retains recognition checkpoints across restart', async () => {
  const f = await fixture()
  try {
    f.failTranslation(true)
    const id = await f.jobs.enqueue(f.source, 1, 45)
    await until(() => f.jobs.state(id)?.job.status === 'failed' && f.leases() === 0)
    await f.restart(); f.failTranslation(false)
    await f.jobs.action(id, 'resume')
    await until(() => f.jobs.state(id)?.job.status === 'completed')
    assert.equal(f.recognizes(), 2)
    assert.equal(f.jobs.state(id)?.job.translatedSeconds, 45)
  } finally { await f.cleanup() }
})

test('other playback pauses work, selected AI takes priority and application exit leaves resumable tasks', async () => {
  const f = await fixture()
  try {
    f.jobs.observe(true, null, 0)
    const id = await f.jobs.enqueue(f.source, 1, 60)
    await delay(30); assert.equal(f.recognizes(), 0)
    f.waitRecognition(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    f.jobs.observe(true, id, 35)
    await until(() => f.recognizes() === 1)
    await f.restart()
    assert.equal(f.leases(), 0)
    assert.equal(f.jobs.state(id)?.job.status, 'paused')
    f.waitRecognition(async () => {})
    await delay(30); assert.equal(f.recognizes(), 1)
    await f.jobs.action(id, 'resume')
    await until(() => f.jobs.state(id)?.job.status === 'completed')
  } finally { await f.cleanup() }
})

test('resource replacement prevents resuming stale tasks', async () => {
  const f = await fixture()
  try {
    f.jobs.observe(true, null, 0)
    const id = await f.jobs.enqueue(f.source, 1, 30)
    f.changeSource(); f.jobs.observe(false, null, 0)
    await until(() => f.jobs.state(id)?.job.status === 'failed')
    assert.equal(f.recognizes(), 0)
    assert.match(f.jobs.state(id)!.job.error!, /资源或资料库/)
  } finally { await f.cleanup() }
})

test('a new translation configuration reuses matching recognition while a new ASR configuration does not', async () => {
  const f = await fixture()
  try {
    const first = await f.jobs.enqueue(f.source, 1, 15)
    await until(() => f.jobs.state(first)?.job.status === 'completed' && f.leases() === 0)
    f.paths.translationVersion = 'tr2'
    const second = await f.jobs.enqueue(f.source, 1, 15)
    assert.notEqual(first, second)
    await until(() => f.jobs.state(second)?.job.status === 'awaiting-save' && f.leases() === 0)
    await f.jobs.action(second, 'retry-save', { filename: path.join(f.root, 'new-translation.ass'), replace: false })
    assert.equal(f.recognizes(), 1); assert.equal(f.translations(), 2)
    f.paths.asrVersion = 'asr2'
    const third = await f.jobs.enqueue(f.source, 1, 15)
    await until(() => f.jobs.state(third)?.job.status === 'awaiting-save' && f.leases() === 0)
    assert.equal(f.recognizes(), 2)
  } finally { await f.cleanup() }
})

test('recognition-only jobs finish without translation', async () => {
  const f = await fixture()
  try {
    const id = await f.jobs.enqueue(f.source, 1, 15, 'japanese')
    await until(() => f.jobs.state(id)?.job.status === 'completed')
    assert.equal(f.translations(), 0)
    assert.match(await fs.readFile(subtitleOutputPath(f.source.locator, 'japanese'), 'utf8'), /原文/)
  } finally { await f.cleanup() }
})

test('exact-stem discovery isolates disc variants and atomic publication never truncates an existing file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-subtitle-files-'))
  try {
    for (const name of ['ABC-123.srt', 'ABC-123.zh-CN.ass', 'ABC-123.zh-ja.ai.ass', 'ABC-123-CD2.srt', 'ABC-1234.srt', 'ABC-123.preview.srt', 'ABC-123.mp4']) await fs.writeFile(path.join(root, name), name)
    assert.deepEqual((await discoverSubtitleFiles(path.join(root, 'ABC-123.mp4'))).map(file => path.basename(file)).sort(), ['ABC-123.srt', 'ABC-123.zh-CN.ass', 'ABC-123.zh-ja.ai.ass'].sort())
    const file = path.join(root, 'ABC-123.srt')
    await assert.rejects(publishSubtitleFile(file, 'replacement'), { code: 'EEXIST' })
    assert.equal(await fs.readFile(file, 'utf8'), 'ABC-123.srt')
    assert.ok(!(await fs.readdir(root)).some(file => file.endsWith('.tmp')))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('closing the playback subscriber keeps generation running without late subtitle commands', async () => {
  const f = await fixture()
  let playback: PlaybackSnapshot | null = { sessionId: 'one', seekable: true, duration: 30, position: 0, phase: 'playing', paused: false, tracks: [] } as unknown as PlaybackSnapshot
  let updates = 0, selected = false
  const native = { selectedAudioStream: () => 1, generatedSubtitleSelected: () => selected,
    updateGeneratedSubtitle: async (_file: string, select: boolean) => { updates++; if (select) selected = true }, removeGeneratedSubtitle: async () => { selected = false } } as unknown as NativePlayback
  const display = createBackgroundSubtitleDisplay({ jobs: f.jobs, root: f.root, native, playback: () => playback,
    source: () => f.source, base: () => ({ installed: true, phase: 'idle', sessionId: null, enabled: false }) as AiSubtitleSnapshot,
    changed: () => {}, exportFile: async () => {} })
  try {
    f.waitRecognition(async signal => { await delay(30, undefined, { signal }) })
    await display.command('one', { action: 'start' })
    const id = display.snapshot()!.taskId!
    await until(() => f.recognizes() === 1)
    playback = null; await display.stop()
    const count = updates
    await until(() => f.jobs.state(id)?.job.status === 'completed')
    assert.equal(updates, count)
    assert.match(await fs.readFile(subtitleOutputPath(f.source.locator, 'bilingual'), 'utf8'), /译文/)
  } finally { await display.close(); await f.cleanup() }
})

test('a manual subtitle choice cancels a pending AI attachment without cancelling its queued work', async () => {
  const f = await fixture()
  let resolve!: () => void
  const blocked = new Promise<void>(done => { resolve = done })
  let entered = false, updates = 0
  const jobs = { ...f.jobs, enqueue: async (...args: Parameters<typeof f.jobs.enqueue>) => { entered = true; await blocked; return f.jobs.enqueue(...args) } }
  const playback = { sessionId: 'one', seekable: true, duration: 30, position: 0, phase: 'playing', paused: false, tracks: [] } as unknown as PlaybackSnapshot
  const native = { selectedAudioStream: () => 1, updateGeneratedSubtitle: async () => { updates++ } } as unknown as NativePlayback
  const display = createBackgroundSubtitleDisplay({ jobs, root: f.root, native, playback: () => playback,
    source: () => f.source, base: () => ({ installed: true, phase: 'idle', sessionId: null, enabled: false }) as AiSubtitleSnapshot,
    changed: () => {}, exportFile: async () => {} })
  try {
    const starting = display.command('one', { action: 'start' })
    await until(() => entered)
    display.selectionChanged(); resolve(); await starting
    assert.equal(display.snapshot()?.enabled, false)
    assert.equal(updates, 0)
    assert.equal((await f.jobs.snapshot()).tasks.length, 1)
  } finally { resolve(); await display.close(); await f.cleanup() }
})

test('removing an attached paused task clears its display and restores the previous subtitle', async () => {
  const f = await fixture()
  const playback = { sessionId: 'one', seekable: true, duration: 30, position: 0, phase: 'playing', paused: false,
    tracks: [{ type: 'sub', id: 9, selected: true }] } as unknown as PlaybackSnapshot
  let selected = false, removed = 0
  const native = { selectedAudioStream: () => 1, generatedSubtitleSelected: () => selected,
    updateGeneratedSubtitle: async (_file: string, select: boolean) => { if (select) selected = true },
    removeGeneratedSubtitle: async (_file: string, previous: number | null) => { assert.equal(previous, 9); selected = false; removed++ }
  } as unknown as NativePlayback
  const display = createBackgroundSubtitleDisplay({ jobs: f.jobs, root: f.root, native, playback: () => playback,
    source: () => f.source, base: () => ({ installed: true, phase: 'idle', sessionId: null, enabled: false }) as AiSubtitleSnapshot,
    changed: () => {}, exportFile: async () => {} })
  try {
    f.waitRecognition(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    await display.command('one', { action: 'start' })
    const id = display.snapshot()!.taskId!
    await until(() => f.recognizes() === 1 && selected)
    await f.jobs.action(id, 'pause')
    assert.equal(display.snapshot()?.enabled, true)
    await f.jobs.action(id, 'remove')
    await until(() => removed === 1)
    assert.equal(display.snapshot()?.enabled, false)
    assert.equal(display.snapshot()?.taskId, undefined)
    display.tick(playback)
    assert.equal(removed, 1)
  } finally { await display.close(); await f.cleanup() }
})
