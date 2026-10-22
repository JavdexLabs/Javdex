import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createLinuxPlaybackFallback } from './linuxPlaybackFallback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
function fixture() {
  const calls: unknown[][] = []
  let state: NativePlaybackState = { alive: true, loadedFiles: 1, seekable: true, pause: false, 'time-pos': 12 }
  let broken = false
  const player: NativePlayback = {
    create: () => { calls.push(['create']); if (broken) throw Error('native') },
    load: (...args) => { calls.push(['load', ...args]) },
    command: (...args) => { calls.push(['command', ...args]) },
    read: () => { if (broken) throw Error('native'); return state },
    render: () => { if (broken) throw Error('native') },
    viewport: (...args) => { calls.push(['viewport', ...args]) },
    addSubtitle: (...args) => { calls.push(['subtitle', ...args]) },
    destroy: () => { calls.push(['destroy']) }
  }
  return { player, calls, break: () => { broken = true }, state: (next: NativePlaybackState) => { state = next } }
}
it('retries a startup failure once without double creating the CPU session', () => {
  const gpu = fixture(), cpu = fixture(); gpu.break()
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto')
  p.create(); assert.deepEqual(cpu.calls, [['create']])
  cpu.break(); assert.throws(() => p.render())
  assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 1)
})
it('restores position, pause, volume and external subtitles after a native failure', async () => {
  const gpu = fixture(), cpu = fixture()
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto')
  p.create(); p.load('/synthetic.avi'); p.read()
  p.command({ kind: 'volume', value: 37 }); p.command({ kind: 'pause', paused: true }); p.addSubtitle('/synthetic.srt')
  gpu.break(); const state = p.read()
  assert.equal(state.playbackMode, 'cpu'); assert.equal(state.playbackFallback, true)
  assert(cpu.calls.some(c => c[0] === 'load' && c[1] === '/synthetic.avi'))
  assert(cpu.calls.some(c => c[0] === 'subtitle' && c[1] === '/synthetic.srt'))
  assert(cpu.calls.some(c => c[0] === 'command' && JSON.stringify(c[1]) === JSON.stringify({ kind: 'seek', seconds: 12 })))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: true }])
})
it('honors explicit modes and never treats media format errors as GPU failures', () => {
  for (const mode of ['gpu', 'cpu'] as const) {
    const gpu = fixture(), cpu = fixture(); const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => mode)
    p.create(); assert.equal((mode === 'cpu' ? gpu : cpu).calls.length, 0)
    ;(mode === 'cpu' ? cpu : gpu).break(); assert.throws(() => p.read())
  }
  const gpu = fixture(), cpu = fixture(); gpu.state({ alive: true, error: 'bad media', errorKind: 'format' })
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto'); p.create()
  assert.equal(p.read().errorKind, 'format'); assert.equal(cpu.calls.length, 0)
})

it('does not fail recovered video when the optional generated subtitle overlay cannot be restored', async () => {
  const gpu = fixture(), cpu = fixture()
  cpu.player.updateGeneratedSubtitle = async () => { throw new Error('optional overlay') }
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto')
  p.create(); p.load('/synthetic.avi'); p.read()
  await p.updateGeneratedSubtitle?.('/synthetic.ass', true, undefined, 'fixture')
  gpu.break(); p.read()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(p.read().playbackMode, 'cpu')
})

it('keeps play intent when the failing GPU reports its initial paused state before load completes', () => {
  const gpu = fixture(), cpu = fixture()
  gpu.state({ alive: true, pause: true, loadedFiles: 0 })
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto')
  p.create(); p.load('/synthetic.avi', { paused: false }); p.read()
  gpu.break(); p.read()
  assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: false }])
})

it('preserves the original error when explicit GPU mode cannot recover', () => {
  const gpu = fixture(), cpu = fixture(); gpu.break()
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'gpu')
  assert.throws(() => p.create(), /native/)
  assert.equal(cpu.calls.length, 0)
})
it('keeps a newer seek while CPU recovery is awaiting the previous position', async () => {
  const gpu = fixture(), cpu = fixture()
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto')
  p.create(); p.load('/synthetic.avi'); p.read(); gpu.break(); p.read()
  p.command({ kind: 'seek', seconds: 40 })
  cpu.state({ alive: true, loadedFiles: 1, seekable: true, pause: true, 'time-pos': 40 })
  assert.equal(p.read()['time-pos'], 40)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(cpu.calls.at(-1), ['command', { kind: 'pause', paused: false }])
  p.destroy()
})

it('records fixed display failure reasons without copying arbitrary error text', () => {
  const gpu = fixture(), cpu = fixture()
  gpu.player.create = () => { throw Object.assign(new Error('/private/media?token=secret'), { playbackFailureCode: 'DISPLAY_SELF_TEST_FAILED' }) }
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto'); p.create()
  assert.equal(p.read().playbackFallbackReason, 'DISPLAY_SELF_TEST_FAILED')
  p.destroy()
})
it('software decoding stays on the GPU display path and tracks observed hardware loss separately', () => {
  const gpu = fixture(), cpu = fixture()
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto'); p.create(); p.load('/fixture')
  gpu.state({ alive: true, 'hwdec-current': 'no' }); assert.equal(p.read().decoderFallback, false)
  gpu.state({ alive: true, 'hwdec-current': 'nvdec-copy' }); p.read()
  gpu.state({ alive: true, 'hwdec-current': 'no' }); const state = p.read()
  assert.equal(state.decoderFallback, true); assert.equal(state.playbackFallback, false); assert.equal(state.playbackMode, 'gpu')
  assert.equal(cpu.calls.length, 0)
  p.load('/next'); assert.equal(p.read().decoderFallback, false); p.destroy()
})

it('bounds CPU recovery when the replacement never finishes loading', t => {
  const gpu = fixture(), cpu = fixture()
  const p = createLinuxPlaybackFallback(gpu.player, cpu.player, () => 'auto')
  t.after(() => p.destroy())
  p.create(); p.load('/fixture'); p.read(); gpu.break()
  cpu.state({ alive: true, loadedFiles: 0 }); p.read()
  const started = Date.now()
  t.mock.method(Date, 'now', () => started + 15001)
  assert.throws(() => p.read(), /CPU 回退恢复超时/)
  assert.equal(cpu.calls.filter(c => c[0] === 'create').length, 1)
})
