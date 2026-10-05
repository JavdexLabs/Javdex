import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import { createOverlayHistory, readOverlayHistoryMarker } from '../interaction/overlayHistory'
import { createPlaybackHistory } from './playbackHistory'

function fixture() {
  const stack: unknown[] = [{ idx: 4, key: 'detail', usr: { from: 'library' } }]
  let index = 0, serial = 0
  const goes: number[] = [], commands: Array<{ id: string; value: PlaybackControl }> = [], options: boolean[] = []
  const history = createOverlayHistory({
    read: () => ({ state: stack[index], url: '#/detail' }),
    push: state => { stack.splice(++index); stack.push(state) }, go: delta => { goes.push(delta) },
    later: () => () => {}, token: () => String(++serial)
  })
  const playback = createPlaybackHistory(history, (id, value) => commands.push({ id, value }), value => options.push(value))
  const state = (presentation: PlaybackSnapshot['presentation'] = 'expanded', phase: PlaybackSnapshot['phase'] = 'playing', sessionId = 'one') =>
    ({ presentation, phase, sessionId } as PlaybackSnapshot)
  const pop = (delta = -1) => { index += delta; history.pop(stack[index]) }
  return { playback, history, state, pop, commands, goes, options, marker: () => readOverlayHistoryMarker(stack[index]), length: () => stack.length }
}
test('back closes options, exits fullscreen, then docks; never stops or rebuilds the session', () => {
  const f = fixture()
  f.playback.observe(f.state())
  f.playback.setOptions(true); f.pop()
  assert.deepEqual(f.options, [true, false]); assert.deepEqual(f.commands, [])
  f.playback.observe(f.state('fullscreen')); f.pop()
  assert.deepEqual(f.commands.at(-1), { id: 'one', value: { kind: 'presentation', value: 'expanded' } })
  f.playback.observe(f.state('expanded')); f.pop()
  assert.deepEqual(f.commands.at(-1), { id: 'one', value: { kind: 'presentation', value: 'docked' } })
  f.playback.observe(f.state('docked'))
  assert.equal(f.marker(), null); assert.deepEqual(f.goes, [])
})
test('fullscreen settings consume their own back step before leaving fullscreen', () => {
  const f = fixture()
  f.playback.observe(f.state()); f.playback.observe(f.state('fullscreen'))
  f.playback.setOptions(true); f.pop()
  assert.deepEqual(f.options, [true, false]); assert.deepEqual(f.commands, [])
  f.pop()
  assert.deepEqual(f.commands.at(-1), { id: 'one', value: { kind: 'presentation', value: 'expanded' } })
})
test('normal updates and mount snapshot never write history; a late old tick cannot reopen a consumed layer', () => {
  const f = fixture()
  f.playback.observe(f.state(), true)
  f.playback.observe(f.state())
  assert.equal(f.length(), 1)
  f.playback.observe(f.state('docked')); f.playback.observe(f.state())
  assert.equal(f.length(), 2)
  f.pop(); f.playback.observe(f.state())
  assert.equal(f.marker(), null)
  assert.equal(f.length(), 2, 'no new marker between back and the committed presentation response')
})
test('explicit fullscreen docking or stop consumes all owned layers without another business back', () => {
  for (const next of [null, 'docked'] as const) {
    const f = fixture()
    f.playback.observe(f.state()); f.playback.observe(f.state('fullscreen'))
    f.playback.observe(next ? f.state(next) : null)
    assert.deepEqual(f.goes, [-2]); f.pop(-2)
    assert.equal(f.marker(), null)
    assert.deepEqual(f.commands, [])
  }
})
test('switching resources reuses the viewing layer but a history close targets only the current session', () => {
  const f = fixture()
  f.playback.observe(f.state()); f.playback.setOptions(true)
  f.playback.observe(f.state('expanded', 'opening', 'two'))
  assert.deepEqual(f.options, [true, false]); f.pop()
  f.pop()
  assert.deepEqual(f.commands, [{ id: 'two', value: { kind: 'presentation', value: 'docked' } }])
})
test('the error surface closes on back and clearing ownership does not control a session or navigate', () => {
  const f = fixture()
  f.playback.observe(f.state('expanded', 'error')); f.pop()
  assert.deepEqual(f.commands, [{ id: 'one', value: { kind: 'stop' } }])
  f.playback.observe(null); f.playback.observe(f.state())
  const commands = f.commands.length
  f.playback.abandon()
  assert.equal(f.commands.length, commands); assert.deepEqual(f.goes, [])
})
