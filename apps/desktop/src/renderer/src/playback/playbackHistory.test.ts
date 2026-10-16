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
    push: state => { stack.splice(++index); stack.push(state) }, replace: state => { stack[index] = state }, go: delta => { goes.push(delta) },
    later: () => () => {}, token: () => String(++serial)
  })
  const playback = createPlaybackHistory(history, (id, value) => commands.push({ id, value }), value => options.push(value))
  const state = (presentation: PlaybackSnapshot['presentation'] = 'expanded', phase: PlaybackSnapshot['phase'] = 'playing', sessionId = 'one') =>
    ({ presentation, phase, sessionId } as PlaybackSnapshot)
  const pop = (delta = -1) => { index += delta; history.pop(stack[index]) }
  return { playback, history, state, pop, commands, goes, options, marker: () => readOverlayHistoryMarker(stack[index]), length: () => stack.length }
}
test('acknowledged docking consumes the viewing entry before navigation without replaying transport commands', () => {
  const f = fixture()
  f.playback.observe(f.state()); f.playback.observe(f.state('fullscreen')); f.playback.setOptions(true)
  f.playback.closeForNavigation()
  let navigated = false
  f.history.afterTraversal(() => { navigated = true })
  assert.equal(navigated, false)
  assert.deepEqual(f.goes, [-1])
  assert.deepEqual(f.commands, [])
  f.pop()
  assert.equal(navigated, true)
  assert.equal(f.marker(), null)
  f.playback.observe(f.state('docked'))
  assert.deepEqual(f.commands, [])
  assert.deepEqual(f.goes, [-1])
})

test('navigation waits for one viewing traversal when the docking event arrives first', () => {
  const f = fixture()
  f.playback.observe(f.state()); f.playback.setOptions(true)
  f.playback.observe(f.state('docked'))
  f.playback.closeForNavigation()
  let navigated = false
  f.history.afterTraversal(() => { navigated = true })
  assert.deepEqual(f.goes, [-1])
  f.pop()
  assert.equal(navigated, true)
  assert.deepEqual(f.goes, [-1])
  assert.deepEqual(f.commands, [])
})

test('one system back docks expanded or fullscreen playback, including open settings, without stopping the session', () => {
  for (const presentation of ['expanded', 'fullscreen'] as const) for (const openSettings of [false, true]) {
    const f = fixture()
    f.playback.observe(f.state())
    f.playback.observe(f.state(presentation))
    if (openSettings) f.playback.setOptions(true)
    assert.equal(f.length(), 2, 'all player presentation modes share one viewing entry')
    f.pop()
    assert.deepEqual(f.commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
    if (openSettings) assert.deepEqual(f.options, [true, false])
    f.playback.observe(f.state('docked'))
    assert.equal(f.marker(), null)
    assert.deepEqual(f.goes, [], 'system back already consumed the viewing entry')
  }
})
test('explicitly closing settings and exiting fullscreen retain the single viewing entry', () => {
  const f = fixture()
  f.playback.observe(f.state()); f.playback.observe(f.state('fullscreen'))
  f.playback.setOptions(true); f.playback.setOptions(false)
  assert.deepEqual(f.options, [true, false]); assert.deepEqual(f.commands, [])
  f.playback.observe(f.state('expanded'))
  assert.equal(f.marker()?.kind, 'playback-expanded')
  assert.equal(f.length(), 2)
  assert.deepEqual(f.goes, [])
  f.pop()
  assert.deepEqual(f.commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
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

test('a restored active session reclaims its existing viewing entry without adding history', () => {
  const f = fixture()
  const token = f.history.open('playback-expanded', () => assert.fail('the previous renderer no longer owns this viewing entry'))
  f.history.abandon(token)
  f.playback.observe(f.state('fullscreen'), true)
  assert.equal(f.length(), 2, 'restoring ownership must not push another viewing entry')
  f.pop()
  assert.deepEqual(f.commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
  assert.deepEqual(f.goes, [])
})
test('explicit fullscreen docking or stop consumes all owned layers without another business back', () => {
  for (const next of [null, 'docked'] as const) {
    const f = fixture()
    f.playback.observe(f.state()); f.playback.observe(f.state('fullscreen'))
    f.playback.observe(next ? f.state(next) : null)
    assert.deepEqual(f.goes, [-1]); f.pop()
    assert.equal(f.marker(), null)
    assert.deepEqual(f.commands, [])
  }
})
test('switching resources reuses the viewing layer but a history close targets only the current session', () => {
  const f = fixture()
  f.playback.observe(f.state()); f.playback.setOptions(true)
  f.playback.observe(f.state('expanded', 'opening', 'two'))
  assert.deepEqual(f.options, [true, false])
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
