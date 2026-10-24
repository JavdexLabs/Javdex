import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createWindowsPlaybackFallback } from './windowsPlaybackFallback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'

function fixture() {
  const calls: unknown[][] = []
  let failure: Error | undefined, cleanupFailure = false
  let state: NativePlaybackState = { alive: true, loadedFiles: 1, seekable: true, pause: false, 'time-pos': 12 }
  const player: NativePlayback = {
    create() { calls.push(['create']); if (failure) throw failure; state.alive = true },
    load(...args) { calls.push(['load', ...args]); if (failure) throw failure },
    command(control) {
      calls.push(['command', control]); if (failure) throw failure
      if (control.kind === 'seek') state['time-pos'] = control.seconds
      if (control.kind === 'pause') state.pause = control.paused
    },
    read() { if (failure) throw failure; return { ...state } },
    render() { if (failure) throw failure },
    viewport(...args) { calls.push(['viewport', ...args]) },
    addSubtitle(...args) { calls.push(['subtitle', ...args]) },
    updateGeneratedSubtitle(...args) { calls.push(['generated', ...args]) },
    destroy() { calls.push(['destroy']); if (cleanupFailure) throw new Error('OpenGL cleanup failed'); state.alive = false }
  }
  return { player, calls, break: (message = 'OpenGL context lost') => { failure = new Error(message) },
    cleanupFails: () => { cleanupFailure = true }, state: (next: Partial<NativePlaybackState>) => { state = { ...state, ...next } } }
}
function pair(options = { forceCpu: () => false, gpuAvailable: () => true }) {
  const gpu = fixture(), cpu = fixture()
  return { gpu, cpu, p: createWindowsPlaybackFallback(gpu.player, cpu.player, options) }
}

test('unsupported graphics initializes CPU once and stays there across subsequent sessions', () => {
  const { gpu, cpu, p } = pair(); gpu.break('OpenGL 3.2 core context is unavailable')
  p.create(); assert.equal(p.read().playbackFallbackReason, 'GPU_INITIALIZATION_FAILED')
  p.destroy(); p.create(); assert.equal(p.read().playbackMode, 'cpu'); p.destroy()
  assert.equal(gpu.calls.filter(c => c[0] === 'create').length, 1)
  assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 2)
})
test('disabled acceleration automatically chooses CPU; an explicit CPU request is not a failure', () => {
  for (const forced of [false, true]) {
    const { gpu, p } = pair({ forceCpu: () => forced, gpuAvailable: () => false })
    p.create(); const value = p.read(); p.destroy()
    assert.equal(gpu.calls.length, 0); assert.equal(value.playbackMode, 'cpu')
    assert.equal(value.playbackFallback, !forced)
    assert.equal(value.playbackFallbackReason, forced ? undefined : 'GPU_DISABLED')
  }
})
test('restores source, position, pause intent, audio and subtitle settings after graphics failure', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/fixture.mkv'); p.read()
  p.command({ kind: 'volume', value: 37 }); p.command({ kind: 'mute', muted: true })
  p.command({ kind: 'speed', value: 1.5 }); p.command({ kind: 'track', type: 'audio', id: 2 })
  p.addSubtitle('/fixture.srt'); p.command({ kind: 'subtitle-delay', seconds: .3 })
  p.command({ kind: 'pause', paused: true }); gpu.break()
  assert.equal(p.read().playbackMode, 'cpu'); await delay(50)
  assert.deepEqual(cpu.calls.filter(c => c[0] === 'load'), [['load', '/fixture.mkv', { paused: true }]])
  assert(cpu.calls.some(c => c[0] === 'subtitle' && c[1] === '/fixture.srt'))
  for (const kind of ['volume', 'mute', 'speed', 'track', 'subtitle-delay', 'seek'])
    assert(cpu.calls.some(c => c[0] === 'command' && (c[1] as { kind: string }).kind === kind), kind)
  assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: true }])
})
test('a load error on the GPU path does not duplicate the replacement load', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy()); p.create(); gpu.break()
  p.load('/fixture.mkv'); p.read(); await delay(25)
  assert.equal(cpu.calls.filter(c => c[0] === 'load').length, 1)
})
test('media, authorization, audio and renderer failures never initiate GPU recovery', () => {
  for (const errorKind of ['format', 'streams', 'audio', 'load'] as const) {
    const { gpu, cpu, p } = pair(); p.create(); gpu.state({ error: 'bad media', errorKind })
    assert.equal(p.read().errorKind, errorKind); assert.equal(cpu.calls.length, 0); p.destroy()
  }
  const { gpu, cpu, p } = pair(); p.create(); gpu.break('播放器页面已关闭，请重启应用后重试')
  assert.throws(() => p.read(), /页面已关闭/); assert.equal(cpu.calls.length, 0); p.destroy()
})
test('a CPU failure is surfaced without retry loops', () => {
  const { gpu, cpu, p } = pair(); gpu.break(); p.create(); cpu.break('CPU rendering failed')
  assert.throws(() => p.read(), /CPU rendering failed/)
  assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 1); p.destroy()
})
test('pending play intent wins over the stale initial pause snapshot', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/fixture.mkv', { paused: false }); gpu.state({ pause: true, 'time-pos': 0 }); p.read()
  gpu.break(); p.read(); await delay(25)
  assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: false }])
})
test('a newer seek and pause during recovery win over the original snapshot', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/fixture.mkv'); p.read(); gpu.break(); p.read()
  p.command({ kind: 'seek', seconds: 40 }); p.command({ kind: 'pause', paused: true })
  await delay(75)
  assert(cpu.calls.some(c => c[0] === 'command' && (c[1] as { seconds?: number }).seconds === 40))
  assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: true }])
})
test('stop/new load cancels restoration before it can seek or unpause another source', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/old.mkv'); p.read(); gpu.break(); p.read()
  p.load('/new.mkv', { paused: true }); const mark = cpu.calls.length
  await delay(50); assert.equal(cpu.calls.length, mark)
})

test('a subtitle selected during the recovery seek is loaded once and remains selected', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/fixture.mkv'); p.read()
  p.command({ kind: 'track', type: 'sub', id: 1 })
  gpu.break(); p.read()
  const mark = cpu.calls.length
  p.addSubtitle('/new.srt')
  await delay(50)
  assert.deepEqual(cpu.calls.filter(c => c[0] === 'subtitle'), [['subtitle', '/new.srt']])
  assert(!cpu.calls.slice(mark).some(c => c[0] === 'command' && (c[1] as { kind: string }).kind === 'track'))
})
test('uncertain GPU cleanup does not block CPU recovery or force GPU resource reuse', async t => {
  const { gpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/fixture.mkv'); p.read(); gpu.cleanupFails(); gpu.break()
  assert.equal(p.read().playbackMode, 'cpu'); await delay(40)
})
test('optional generated subtitles are restored, and an overlay failure does not stop video', async t => {
  const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
  p.create(); p.load('/fixture.mkv'); p.read()
  await p.updateGeneratedSubtitle?.('/ai.ass', true, undefined, 'timeline')
  cpu.player.updateGeneratedSubtitle = async () => { throw new Error('optional subtitle failure') }
  gpu.break(); p.read(); await delay(50)
  assert.equal(p.read().playbackMode, 'cpu')
})
