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
  assert.fail('subtitle display regression did not reach the expected state')
}

test('silent scheduler publications retain a display warning until explicit retry clears and redraws it', { timeout: 5000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-display-error-'))
  const playback = {
    sessionId: 'display-error', phase: 'playing', seekable: true, duration: 60, position: 0, tracks: []
  } as unknown as PlaybackSnapshot
  const source: PlaybackSource = {
    target: { libraryId: 1, videoId: 1, resourceId: 1 }, mode: 'local',
    locator: path.join(root, 'fixture.mp4'), identityKey: 'display-error', revision: 'one',
    resumeKey: 'display-error', title: 'fixture'
  }
  const updates: Array<{ filename: string; select: boolean; document: string }> = []
  const publications: AiSubtitleSnapshot[] = []
  const recognizedStarts: number[] = []
  let subtitleErrors = 0
  let finishSilentChunk: (() => void) | null = null
  const native: NativePlayback = {
    create: () => {}, load: () => {}, command: () => {}, read: () => ({ alive: true }),
    viewport: () => {}, render: () => {}, addSubtitle: () => {}, destroy: () => {},
    selectedAudioStream: () => 1,
    subtitleCommandErrors: () => subtitleErrors,
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
    await until(() => finishSilentChunk !== null && updates.at(-1)?.document.includes('你好') === true)
    const beforeFailure = updates.length
    const filename = updates.at(-1)!.filename
    subtitleErrors++
    controller.tick(playback)
    const warning = controller.snapshot().error
    assert.match(warning!, /字幕显示更新失败.*播放不受影响/)
    const publicationBoundary = publications.length

    finishSilentChunk!()
    await until(() => controller.snapshot().translatedSeconds === 60 && controller.snapshot().activeStart === null)
    assert.equal(updates.length, beforeFailure, 'a silent chunk must not issue a subtitle redraw')
    const silentPublications = publications.slice(publicationBoundary)
    assert.ok(silentPublications.length > 0, 'the real scheduler must publish after the display failure')
    assert.ok(silentPublications.every(value => value.error === warning), 'inference publications must retain the unresolved display warning')
    assert.equal(controller.snapshot().error, warning)
    assert.equal(controller.snapshot().enabled, true)
    assert.equal(playback.phase, 'playing')

    const retried = await controller.command(playback.sessionId, { action: 'retry' })
    assert.equal(retried.error, null, 'explicit retry must clear the owned display warning')
    await until(() => updates.length > beforeFailure)
    assert.equal(updates.length, beforeFailure + 1)
    assert.equal(updates.at(-1)!.filename, filename, 'retry must redraw the same subtitle track')
    assert.equal(updates.at(-1)!.select, true)
    assert.match(updates.at(-1)!.document, /你好/)
    assert.match(updates.at(-1)!.document, /こんにちは/)
    assert.deepEqual(recognizedStarts, [0, 30], 'display retry must not repeat recognition')
    controller.tick(playback)
    assert.equal(controller.snapshot().error, null, 'the already-observed counter must not resurrect the warning')
  } finally {
    await controller.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
