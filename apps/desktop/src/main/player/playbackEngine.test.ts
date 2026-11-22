import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PlaybackRenderMode } from '@shared/desktop/playback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import { createPlaybackEngine } from './playbackEngine'
import { graphicsPlaybackFailure } from './playbackGraphicsFailure'

function producer() {
  const calls: string[] = []
  let failure: Error | undefined
  const state: NativePlaybackState = { alive: true, loadedFiles: 1, seekable: true, pause: false, 'time-pos': 0 }
  const native: NativePlayback = {
    create() { calls.push('create'); if (failure) throw failure; state.alive = true },
    load() { calls.push('load'); if (failure) throw failure },
    command(value) { if (value.kind === 'seek') state['time-pos'] = value.seconds; if (value.kind === 'pause') state.pause = value.paused },
    read() { if (failure) throw failure; return { ...state } },
    viewport() {}, render() {}, addSubtitle() {}, destroy() { calls.push('destroy'); state.alive = false }
  }
  return { native, calls, state, fail: (value?: Error) => { failure = value } }
}

describe('shared playback modes', () => {
  function fixture(initial: PlaybackRenderMode = 'auto', available = true) {
    const gpu = producer(), cpu = producer()
    let mode = initial
    // Both producers are injected. The platform argument only labels recovery logs.
    const engine = createPlaybackEngine(gpu.native, cpu.native, { mode: () => mode, gpuAvailable: () => available }, 'linux')
    return { gpu, cpu, engine, mode: (value: PlaybackRenderMode) => { mode = value } }
  }
  test('CPU mode bypasses GPU and is reported as a manual choice', () => {
    const { engine, gpu } = fixture('cpu', false)
    engine.create(); assert.equal(engine.read().playbackMode, 'cpu'); assert.equal(engine.read().playbackFallback, false)
    assert.equal(gpu.calls.length, 0); engine.destroy()
  })
  test('choosing CPU after automatic recovery clears only the displayed fallback state', () => {
    const f = fixture(); f.gpu.fail(graphicsPlaybackFailure('TEXTURE_IMPORT_FAILED'))
    f.engine.create(); assert.equal(f.engine.read().playbackFallback, true); f.engine.destroy()
    f.gpu.fail(); f.mode('cpu'); f.engine.create()
    assert.equal(f.engine.read().playbackMode, 'cpu')
    assert.equal(f.engine.read().playbackFallback, false)
    assert.equal(f.engine.read().playbackFallbackReason, undefined)
    f.engine.destroy(); f.mode('auto'); f.engine.create()
    assert.equal(f.engine.read().playbackFallback, true, 'automatic mode retains the earlier graphics failure until explicit GPU retry')
    f.engine.destroy()
  })
  test('explicit GPU mode fails without silently loading CPU', () => {
    const { engine, gpu, cpu } = fixture('gpu')
    const failure = graphicsPlaybackFailure('FRAME_RENDER_FAILED')
    gpu.fail(failure)
    assert.throws(() => engine.create(), error => error === failure); assert.equal(cpu.calls.length, 0); engine.destroy()
    const disabled = fixture('gpu', false)
    assert.throws(() => disabled.engine.create()); assert.equal(disabled.cpu.calls.length, 0); disabled.engine.destroy()
  })
  test('GPU load failure loads its authorized CPU replacement exactly once', () => {
    const { engine, gpu, cpu } = fixture(); engine.create(); gpu.fail(graphicsPlaybackFailure('FRAME_RENDER_FAILED'))
    engine.load('/synthetic.mkv', { paused: false })
    assert.equal(cpu.calls.filter(value => value === 'load').length, 1); engine.destroy()
  })
  test('structured page and media failures do not trigger graphics recovery', () => {
    const { engine, gpu, cpu } = fixture(); engine.create()
    gpu.fail(Object.assign(new Error('closed'), { playbackFailureKind: 'page', playbackFailureCode: 'RENDERER_REPLACED' }))
    assert.throws(() => engine.read()); assert.equal(cpu.calls.length, 0); engine.destroy()
  })
  test('automatic recovery stays stable until an explicit GPU retry', () => {
    const f = fixture(); f.gpu.fail(graphicsPlaybackFailure('TEXTURE_IMPORT_FAILED'))
    f.engine.create(); f.engine.destroy(); f.gpu.fail()
    f.engine.create(); assert.equal(f.engine.read().playbackMode, 'cpu'); f.engine.destroy()
    f.mode('gpu'); f.engine.create(); assert.equal(f.engine.read().playbackMode, 'gpu'); f.engine.destroy()
  })
})
