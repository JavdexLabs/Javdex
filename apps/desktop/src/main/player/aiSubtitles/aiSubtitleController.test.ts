import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback } from '../nativePlayback'
import type { PlaybackSource } from '../playbackSource'
import { createAiSubtitleController } from './aiSubtitleController'
import { createAiRuntimeInstaller } from './runtimeInstaller'
import { createOfflineSubtitleInference } from './offlineInference'

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(5) }
  assert.fail('controller did not reach expected state')
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-controller-'))
  let playback = { sessionId: 'one', phase: 'playing', seekable: true, duration: 15, position: 0,
    tracks: [{ type: 'sub', id: 8, title: null, language: null, codec: null, channelCountHint: null, selected: true }] } as PlaybackSnapshot
  let audio = 1, privateSession = false, closeCount = 0, recognizeCount = 0, selected = false
  let leases = 0, finishClose = async (): Promise<void> => {}
  const updates: Array<{ filename: string; select: boolean }> = [], removals: Array<number | null> = []
  const source: PlaybackSource = { target: { libraryId: 1, videoId: 1, resourceId: 1 }, mode: 'remote',
    locator: 'https://fixture.invalid/grant?secret=original', identityKey: 'fixture', revision: 'one', resumeKey: 'one', title: 'fixture' }
  const native: NativePlayback = { create: () => {}, load: () => {}, command: () => {}, read: () => ({ alive: true }),
    viewport: () => {}, render: () => {}, addSubtitle: () => {}, destroy: () => {},
    selectedAudioStream: () => audio, generatedSubtitleSelected: () => selected,
    updateGeneratedSubtitle: (filename: string, select: boolean) => {
      updates.push({ filename, select })
      if (select) {
        selected = true
        playback = { ...playback, tracks: [{ type: 'sub', id: 9, title: 'AI', language: null, codec: null, channelCountHint: null, selected: true }] }
      }
    },
    removeGeneratedSubtitle: (_: string, restore: number | null) => {
      removals.push(restore); selected = false
      playback = { ...playback, tracks: [{ type: 'sub', id: 8, title: null, language: null, codec: null, channelCountHint: null, selected: restore === 8 }] }
    }
  }
  const runtime = { ...createAiRuntimeInstaller(path.join(root, 'models')), installed: async () => true }
  let resolve = async (value: PlaybackSource) => ({ ...value, locator: 'https://fixture.invalid/grant?secret=renewed' })
  const controller = createAiSubtitleController({ root, runtime, native, playback: () => playback,
    source: () => ({ source, privateSession }), resolve: value => resolve(value), changed: () => {}, exportFile: async () => {},
    acquireRuntime: async () => { leases++; return () => { leases-- } },
    inference: (() => ({
      probe: async (_: string, index: number) => ({ index, identity: `audio-${index}` }),
      recognize: async (locator: string, index: number, start: number, end: number, signal: AbortSignal) => {
        assert.ok(locator.includes('renewed')); recognizeCount++
        await delay(5, undefined, { signal })
        return [{ start, end, japanese: `音轨${index}` }]
      },
      translate: async cues => cues.map(cue => ({ ...cue, chinese: '译文' })),
      translateText: async () => '译文',
      close: async () => { closeCount++; await finishClose() }
    })) as typeof createOfflineSubtitleInference
  })
  return { controller, root, updates, removals, setAudio: (value: number) => { audio = value },
    setPrivate: () => { privateSession = true }, setSession: () => { playback = { ...playback, sessionId: 'two' } },
    setResolve: (value: typeof resolve) => { resolve = value }, tick: () => controller.tick(playback),
    recognizes: () => recognizeCount, closes: () => closeCount,
    leases: () => leases, setClose: (value: typeof finishClose) => { finishClose = value },
    cleanup: async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }) }
  }
}

test('incremental display preserves selection, restores original subtitles and reuses cache', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.length > 0)
    await f.controller.command('one', { action: 'display', value: 'japanese' })
    await until(() => f.updates.length >= 2)
    assert.equal(f.updates[0].select, true); assert.equal(f.updates.at(-1)?.select, false)
    const filename = f.updates[0].filename
    await f.controller.command('one', { action: 'stop' })
    assert.equal(f.removals[0], 8)
    assert.equal(await fs.access(filename).then(() => true, () => false), false)
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    assert.equal(f.recognizes(), 1)
  } finally { await f.cleanup() }
})

test('audio and private-session changes invalidate current work without persisting private cues', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    f.setAudio(2); f.tick()
    await until(() => f.recognizes() === 2 && f.controller.snapshot().translatedSeconds === 15)
    const before = await fs.readdir(path.join(f.root, 'cache'))
    f.setPrivate(); f.tick()
    await until(() => f.recognizes() === 3 && f.controller.snapshot().translatedSeconds === 15)
    assert.deepEqual(await fs.readdir(path.join(f.root, 'cache')), before)
    f.setSession(); f.tick()
    await until(() => f.controller.snapshot().sessionId === null)
    assert.equal(f.controller.snapshot().enabled, false); assert.ok(f.closes() >= 3)
  } finally { await f.cleanup() }
})

test('stop during source preparation prevents late inference and subtitle publication', async () => {
  const f = await fixture()
  let release!: () => void
  f.setResolve(async value => { await new Promise<void>(resolve => { release = resolve }); return value })
  try {
    const start = f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().phase === 'preparing')
    await f.controller.command('one', { action: 'stop' }); release(); await start
    assert.equal(f.controller.snapshot().enabled, false); assert.equal(f.recognizes(), 0); assert.equal(f.updates.length, 0)
  } finally { await f.cleanup() }
})

test('rapid restart waits for the old shutdown and retains the new model lease and subtitle state', async () => {
  const f = await fixture()
  let releaseClose!: () => void
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.length > 0)
    f.setClose(() => new Promise<void>(resolve => { releaseClose = resolve }))
    const oldFile = f.updates[0].filename
    const stop = f.controller.command('one', { action: 'stop' })
    await until(() => f.closes() === 1)
    const first = f.controller.command('one', { action: 'start' })
    const second = f.controller.command('one', { action: 'start' })
    await delay(20)
    assert.equal(f.leases(), 1)
    assert.equal(f.controller.snapshot().enabled, false)
    releaseClose()
    await Promise.all([stop, first, second])
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.some(update => update.filename !== oldFile && update.select))
    assert.equal(f.controller.snapshot().sessionId, 'one')
    assert.equal(f.controller.snapshot().enabled, true)
    assert.equal(f.leases(), 1)
    assert.equal(f.removals.length, 1)
    assert.equal(f.recognizes(), 1)
    f.setClose(async () => {})
    await f.controller.command('one', { action: 'stop' })
    assert.deepEqual(f.removals, [8, 8], 'a restart during shutdown still restores the original subtitle track')
  } finally { releaseClose?.(); f.setClose(async () => {}); await f.cleanup() }
})
