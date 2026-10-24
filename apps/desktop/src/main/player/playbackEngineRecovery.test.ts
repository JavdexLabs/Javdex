import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createPlaybackEngine } from './playbackEngine'
import { createPlaybackSession } from './playbackSession'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'

function fixture() {
  const calls: unknown[][] = []
  let failure: Error | undefined, cleanupFailure = false
  let state: NativePlaybackState = { alive: true, loadedFiles: 1, seekable: true, pause: false, 'time-pos': 12, volume: 50 }
  const player: NativePlayback = {
    create() { calls.push(['create']); if (failure) throw failure; state.alive = true },
    load(...args) { calls.push(['load', ...args]); if (failure) throw failure },
    command(control) {
      calls.push(['command', control]); if (failure) throw failure
      if (control.kind === 'seek') state['time-pos'] = control.seconds
      if (control.kind === 'pause') state.pause = control.paused
      if (control.kind === 'volume') state.volume = control.value
    },
    read() { if (failure) throw failure; return { ...state } },
    render() { if (failure) throw failure },
    viewport(...args) { calls.push(['viewport', ...args]) },
    addSubtitle(...args) { calls.push(['subtitle', ...args]) },
    updateGeneratedSubtitle(...args) { calls.push(['generated', ...args]) },
    destroy() { calls.push(['destroy']); if (cleanupFailure) throw Object.assign(new Error('OpenGL cleanup failed'), { playbackFailureKind: 'graphics' }); state.alive = false }
  }
  return { player, calls, break: (message = 'OpenGL context lost', kind: 'graphics' | 'page' = 'graphics') => {
    failure = Object.assign(new Error(message), kind ? { playbackFailureKind: kind } : {})
  },
    cleanupFails: () => { cleanupFailure = true }, state: (next: Partial<NativePlaybackState>) => { state = { ...state, ...next } } }
}
for (const platform of ['darwin', 'win32', 'linux'] as const) {
  function pair(options = { forceCpu: () => false, gpuAvailable: () => true }) {
    const gpu = fixture(), cpu = fixture()
    return { gpu, cpu, p: createPlaybackEngine(gpu.player, cpu.player, { mode: () => options.forceCpu() ? 'cpu' : 'auto', gpuAvailable: options.gpuAvailable }, platform) }
  }

  test(`${platform}: unsupported graphics initializes CPU once and stays there across subsequent sessions`, () => {
    const { gpu, cpu, p } = pair(); gpu.break('OpenGL 3.2 core context is unavailable')
    p.create(); assert.equal(p.read().playbackFallbackReason, 'GPU_INITIALIZATION_FAILED')
    p.destroy(); p.create(); assert.equal(p.read().playbackMode, 'cpu'); p.destroy()
    assert.equal(gpu.calls.filter(c => c[0] === 'create').length, 1)
    assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 2)
  })
  test(`${platform}: disabled acceleration automatically chooses CPU; an explicit CPU request is not a failure`, () => {
    for (const forced of [false, true]) {
      const { gpu, p } = pair({ forceCpu: () => forced, gpuAvailable: () => false })
      p.create(); const value = p.read(); p.destroy()
      assert.equal(gpu.calls.length, 0); assert.equal(value.playbackMode, 'cpu')
      assert.equal(value.playbackFallback, !forced)
      assert.equal(value.playbackFallbackReason, forced ? undefined : 'GPU_DISABLED')
    }
  })

  test(`${platform}: localized shared-frame production failures recover through their structured graphics domain`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/subtitle-fixture.mkv'); p.read()
    p.command({ kind: 'pause', paused: true }); p.command({ kind: 'track', type: 'sub', id: 1 })
    gpu.break('Windows 共享视频生产失败，请重启应用后重试', 'graphics')
    assert.equal(p.read().playbackMode, 'cpu')
    assert.equal(p.read().playbackFallbackReason, 'GPU_RUNTIME_FAILED')
    await delay(50)
    assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 1)
    assert(cpu.calls.some(c => c[0] === 'command' && (c[1] as { kind: string; id?: number }).kind === 'track' && (c[1] as { id?: number }).id === 1))
    assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: true }])
  })

  test(`${platform}: a page failure cannot become a graphics recovery because its text contains GPU`, () => {
    const { gpu, cpu, p } = pair(); p.create(); gpu.break('GPU canvas navigation ended', 'page')
    assert.throws(() => p.read(), /navigation ended/)
    assert.equal(cpu.calls.length, 0); p.destroy()
  })
  test(`${platform}: restores source, position, pause intent, audio and subtitle settings after graphics failure`, async t => {
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
  test(`${platform}: a load error on the GPU path does not duplicate the replacement load`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy()); p.create(); gpu.break()
    p.load('/fixture.mkv'); p.read(); await delay(25)
    assert.equal(cpu.calls.filter(c => c[0] === 'load').length, 1)
  })
  test(`${platform}: media, authorization, audio and renderer failures never initiate GPU recovery`, () => {
    for (const errorKind of ['format', 'streams', 'audio', 'load'] as const) {
      const { gpu, cpu, p } = pair(); p.create(); gpu.state({ error: 'bad media', errorKind })
      assert.equal(p.read().errorKind, errorKind); assert.equal(cpu.calls.length, 0); p.destroy()
    }
    const { gpu, cpu, p } = pair(); p.create(); gpu.break('播放器页面已关闭，请重启应用后重试', 'page')
    assert.throws(() => p.read(), /页面已关闭/); assert.equal(cpu.calls.length, 0); p.destroy()
  })
  test(`${platform}: a CPU failure is surfaced without retry loops`, () => {
    const { gpu, cpu, p } = pair(); gpu.break(); p.create(); cpu.break('CPU rendering failed')
    assert.throws(() => p.read(), /CPU rendering failed/)
    assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 1); p.destroy()
  })
  test(`${platform}: pending play intent wins over the stale initial pause snapshot`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/fixture.mkv', { paused: false }); gpu.state({ pause: true, 'time-pos': 0 }); p.read()
    gpu.break(); p.read(); await delay(25)
    assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: false }])
  })
  test(`${platform}: a newer seek and pause during recovery win over the original snapshot`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/fixture.mkv'); p.read(); gpu.break(); p.read()
    p.command({ kind: 'seek', seconds: 40 }); p.command({ kind: 'pause', paused: true })
    await delay(75)
    assert(cpu.calls.some(c => c[0] === 'command' && (c[1] as { seconds?: number }).seconds === 40))
    assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: true }])
  })
  test(`${platform}: stop/new load cancels restoration before it can seek or unpause another source`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/old.mkv'); p.read(); gpu.break(); p.read()
    p.load('/new.mkv', { paused: true }); const mark = cpu.calls.length
    await delay(50); assert.equal(cpu.calls.length, mark)
  })

  test(`${platform}: a subtitle selected during the recovery seek is loaded once and remains selected`, async t => {
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
  test(`${platform}: uncertain GPU cleanup does not block CPU recovery or force GPU resource reuse`, async t => {
    const { gpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/fixture.mkv'); p.read(); gpu.cleanupFails(); gpu.break()
    assert.equal(p.read().playbackMode, 'cpu'); await delay(40)
  })
  test(`${platform}: optional generated subtitles are restored, and an overlay failure does not stop video`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/fixture.mkv'); p.read()
    await p.updateGeneratedSubtitle?.('/ai.ass', true, undefined, 'timeline')
    cpu.player.updateGeneratedSubtitle = async () => { throw new Error('optional subtitle failure') }
    gpu.break(); p.read(); await delay(50)
    assert.equal(p.read().playbackMode, 'cpu')
  })
  test(`${platform}: an unavailable optional subtitle observation does not block graphics recovery`, async t => {
    const { gpu, cpu, p } = pair(); t.after(() => p.destroy())
    p.create(); p.load('/fixture.mkv'); p.read()
    await p.updateGeneratedSubtitle?.('/ai.ass', true, undefined, 'timeline')
    await p.updateGeneratedSubtitle?.('/ai.ass', false, undefined, 'updated timeline')
    gpu.player.generatedSubtitleSelected = () => { throw new Error('lost overlay observation') }
    gpu.break(); assert.equal(p.read().playbackMode, 'cpu'); await delay(50)
    assert(cpu.calls.some(c => c[0] === 'generated' && c[1] === '/ai.ass' && c[2] === true))
    assert.equal(p.read().playbackMode, 'cpu')
  })
  test(`${platform}: default playback remains GPU and platform context errors select CPU`, () => {
    const { gpu, cpu, p } = pair()
    p.create(); assert.equal(p.read().playbackMode, 'gpu'); assert.equal(cpu.calls.length, 0)
    gpu.break(platform === 'darwin' ? 'Cannot create IOSurface render context' : 'Cannot create D3D device')
    assert.equal(p.read().playbackMode, 'cpu'); p.destroy()
  })
  test(`${platform}: CPU loading after a long GPU session gets its own bounded opening window`, async t => {
    const { gpu, cpu, p } = pair()
    let time = 1000, resolutions = 0
    const session = createPlaybackSession({ native: p, resolve: async target => {
      resolutions++
      return { target, title: 'fixture', mode: 'local', locator: '/fixture.mp4', identityKey: 'fixture', revision: '1', resumeKey: 'fixture' }
    }, validate: async () => {}, changed() {}, presentation() {}, started: async () => {}, awake() {},
    windowSize: () => ({ width: 640, height: 360 }), now: () => time })
    t.after(() => session.stop())
    await session.open({ libraryId: 1, videoId: 1, resourceId: 1 }); session.tick()
    time += 31000
    cpu.state({ loadedFiles: 0 }); gpu.break(); session.tick()
    assert.equal(session.snapshot()!.phase, 'opening', 'the CPU loading gap is not the original GPU opening timeout')
    assert.equal(session.snapshot()!.info.playbackMode, 'cpu')
    cpu.state({ loadedFiles: 1 }); session.tick(); await delay(50); session.tick()
    assert.equal(session.snapshot()!.phase, 'playing')
    assert.equal(resolutions, 1)
  })
  test(`${platform}: saved volume set before the initial load survives CPU replacement`, async t => {
    const { gpu, p } = pair()
    const session = createPlaybackSession({ native: p, resolve: async target => ({ target, title: 'fixture', mode: 'local',
      locator: '/fixture.mp4', identityKey: 'fixture', revision: '1', resumeKey: 'fixture' }),
    validate: async () => {}, changed() {}, presentation() {}, started: async () => {}, awake() {}, readVolume: async () => 37,
    windowSize: () => ({ width: 640, height: 360 }) })
    t.after(() => session.stop())
    await session.open({ libraryId: 1, videoId: 1, resourceId: 1 }); session.tick()
    assert.equal(session.snapshot()!.volume, 37)
    gpu.break(); session.tick(); await delay(50); session.tick()
    assert.equal(session.snapshot()!.volume, 37)
  })
}
