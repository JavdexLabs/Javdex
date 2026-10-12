import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback } from '../nativePlayback'
import type { PlaybackSource } from '../playbackSource'
import { createAiRuntimeInstaller } from '../../services/localModels/runtimeInstaller'
import { createAiSubtitleController } from './aiSubtitleController'
import type { SubtitleCue } from './subtitleDocument'

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail('subtitle write regression did not reach the expected state')
}

test('a failed ASS write waits for explicit retry despite later scheduler publications', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-write-failure-'))
  const playback = {
    sessionId: 'write-failure', phase: 'playing', seekable: true, duration: 60, position: 0, tracks: []
  } as unknown as PlaybackSnapshot
  const source: PlaybackSource = {
    target: { libraryId: 1, videoId: 1, resourceId: 1 }, mode: 'local',
    locator: path.join(root, 'fixture.mp4'), identityKey: 'write-failure', resumeKey: 'write-failure',
    revision: 'one', title: 'fixture'
  }
  const writes: string[] = []
  const updates: Array<{ filename: string; select: boolean; document: string }> = []
  const publications: AiSubtitleSnapshot[] = []
  const recognizedStarts: number[] = []
  let rejectWrites = true
  let releaseFailedWrite!: () => void
  const failedWrite = new Promise<void>(resolve => { releaseFailedWrite = resolve })
  let finishSilentChunk: (() => void) | null = null
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (typeof to === 'string' && to.startsWith(`${root}${path.sep}`) && to.endsWith('.ass')) {
      writes.push(to)
      if (writes.length === 1) await failedWrite
      if (rejectWrites) throw new Error('fixture ASS rename denied')
    }
    await rename(from, to)
  })
  const native: NativePlayback = {
    create: () => {}, load: () => {}, command: () => {}, read: () => ({ alive: true }),
    viewport: () => {}, render: () => {}, addSubtitle: () => {}, destroy: () => {},
    selectedAudioStream: () => 1,
    updateGeneratedSubtitle: (filename, select) => {
      updates.push({ filename, select, document: readFileSync(filename, 'utf8') })
    }
  }
  const runtime = createAiRuntimeInstaller(path.join(root, 'models'))
  const controller = createAiSubtitleController({
    root, native, runtime: { installed: async () => true, paths: runtime.paths },
    playback: () => playback, source: () => source, resolve: async value => value,
    changed: value => publications.push(value), exportFile: async () => {},
    inference: () => ({
      probe: async (_locator, index) => ({ index, identity: 'fixture-audio' }),
      recognize: async (_locator, _index, start, _end, signal) => {
        recognizedStarts.push(start)
        if (start === 0) return [{ start: 0, end: 2, japanese: 'こんにちは' }]
        assert.equal(start, 30)
        return new Promise<SubtitleCue[]>((resolve, reject) => {
          const abort = (): void => { reject(signal.reason) }
          signal.addEventListener('abort', abort, { once: true })
          finishSilentChunk = () => {
            signal.removeEventListener('abort', abort)
            resolve([])
          }
          if (signal.aborted) abort()
        })
      },
      translate: async cues => cues.map(cue => ({ ...cue, chinese: '你好' })),
      translateText: async () => '你好', close: async () => {}
    })
  })
  try {
    await controller.command(playback.sessionId, { action: 'start' })
    // Hold the first rename until the scheduler is paused on its next audio chunk.
    await until(() => finishSilentChunk !== null && writes.length === 1)
    releaseFailedWrite()
    await until(() => controller.snapshot().error !== null)
    // Let the failed atomic write settle before releasing the next scheduler publication.
    await delay(20)
    assert.equal(writes.length, 1, 'a failed write must not restart its completion drain')
    assert.equal(updates.length, 0, 'a failed atomic write must not publish a native subtitle')
    const filename = writes[0]
    const warning = controller.snapshot().error
    assert.match(warning!, /字幕显示更新失败.*播放不受影响/)
    const publicationBoundary = publications.length

    finishSilentChunk!()
    await until(() => controller.snapshot().translatedSeconds === 60 && controller.snapshot().activeStart === null)
    // Filesystem completion follows the scheduler publication that requested the redraw.
    await delay(20)
    assert.ok(publications.length > publicationBoundary, 'the real scheduler must publish after the failed write')
    assert.equal(writes.length, 1, 'scheduler publications must not retry a failed ASS write without an explicit retry')
    assert.equal(controller.snapshot().error, warning)
    assert.equal(controller.snapshot().enabled, true)
    assert.equal(playback.phase, 'playing')
    assert.equal(updates.length, 0)

    rejectWrites = false
    const retried = await controller.command(playback.sessionId, { action: 'retry' })
    assert.equal(retried.error, null)
    await until(() => updates.length > 0)
    assert.deepEqual(writes, [filename, filename], 'explicit retry must redraw the same subtitle track once')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].filename, filename)
    assert.equal(updates[0].select, true)
    assert.match(updates[0].document, /こんにちは/)
    assert.match(updates[0].document, /你好/)
    assert.deepEqual(recognizedStarts, [0, 30], 'display retry must not repeat ASR')
    assert.equal(controller.snapshot().error, null)
  } finally {
    releaseFailedWrite()
    await controller.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('explicit retry during failed write completion redraws without another scheduler publication', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-retry-completion-'))
  const playback = {
    sessionId: 'retry-completion', phase: 'playing', seekable: true, duration: 60, position: 0, tracks: []
  } as unknown as PlaybackSnapshot
  const source: PlaybackSource = {
    target: { libraryId: 1, videoId: 1, resourceId: 1 }, mode: 'local',
    locator: path.join(root, 'fixture.mp4'), identityKey: 'retry-completion', resumeKey: 'retry-completion',
    revision: 'one', title: 'fixture'
  }
  const writes: string[] = []
  const updates: Array<{ filename: string; document: string }> = []
  const recognizedStarts: number[] = []
  let releaseFailedWrite!: () => void
  const failedWrite = new Promise<void>(resolve => { releaseFailedWrite = resolve })
  let nextChunkPaused = false
  let retry: Promise<AiSubtitleSnapshot> | null = null
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (typeof to === 'string' && to.startsWith(`${root}${path.sep}`) && to.endsWith('.ass')) {
      writes.push(to)
      if (writes.length === 1) {
        await failedWrite
        throw new Error('fixture first ASS rename denied')
      }
    }
    await rename(from, to)
  })
  const native: NativePlayback = {
    create: () => {}, load: () => {}, command: () => {}, read: () => ({ alive: true }),
    viewport: () => {}, render: () => {}, addSubtitle: () => {}, destroy: () => {},
    selectedAudioStream: () => 1,
    updateGeneratedSubtitle: filename => { updates.push({ filename, document: readFileSync(filename, 'utf8') }) }
  }
  const runtime = createAiRuntimeInstaller(path.join(root, 'models'))
  const controller = createAiSubtitleController({
    root, native, runtime: { installed: async () => true, paths: runtime.paths },
    playback: () => playback, source: () => source, resolve: async value => value, exportFile: async () => {},
    changed: value => {
      // The public command resumes after initialization, before the failed render's finalizer.
      if (value.error && retry === null) retry = controller.command(playback.sessionId, { action: 'retry' })
    },
    inference: () => ({
      probe: async (_locator, index) => ({ index, identity: 'fixture-audio' }),
      recognize: async (_locator, _index, start, _end, signal) => {
        recognizedStarts.push(start)
        if (start === 0) return [{ start: 0, end: 2, japanese: 'こんにちは' }]
        assert.equal(start, 30)
        return new Promise<SubtitleCue[]>((_resolve, reject) => {
          const abort = (): void => { reject(signal.reason) }
          signal.addEventListener('abort', abort, { once: true })
          nextChunkPaused = true
          if (signal.aborted) abort()
        })
      },
      translate: async cues => cues.map(cue => ({ ...cue, chinese: '你好' })),
      translateText: async () => '你好', close: async () => {}
    })
  })
  try {
    await controller.command(playback.sessionId, { action: 'start' })
    await until(() => nextChunkPaused && writes.length === 1)
    releaseFailedWrite()
    await until(() => retry !== null)
    const retried = await retry!
    assert.equal(retried.error, null)
    await until(() => updates.length > 0)
    assert.equal(updates.length, 1, 'explicit retry must redraw even when the failed render has not released its Promise')
    assert.deepEqual(writes, [writes[0], writes[0]], 'retry must write the same track once')
    assert.equal(updates[0].filename, writes[0])
    assert.match(updates[0].document, /こんにちは/)
    assert.match(updates[0].document, /你好/)
    assert.deepEqual(recognizedStarts, [0, 30], 'display retry must not repeat ASR')
  } finally {
    releaseFailedWrite()
    await controller.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
