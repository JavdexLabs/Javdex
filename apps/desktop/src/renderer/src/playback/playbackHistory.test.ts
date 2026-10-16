import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import { createOverlayHistory, readOverlayHistoryMarker } from '../interaction/overlayHistory'
import { createPlaybackHistory } from './playbackHistory'

function fixture() {
  const stack: unknown[] = [{ idx: 4, key: 'detail', usr: { from: 'library' } }]
  let index = 0, serial = 0
  const goes: number[] = [], commands: Array<{ id: string; value: PlaybackControl }> = [], options: boolean[] = []
  const port: Parameters<typeof createOverlayHistory>[0] = {
    read: () => ({ state: stack[index], url: '#/detail' }),
    push: state => { stack.splice(++index); stack.push(state) }, replace: state => { stack[index] = state }, go: delta => { goes.push(delta) },
    later: () => () => {}, token: () => String(++serial)
  }
  const history = createOverlayHistory(port)
  const playback = createPlaybackHistory(history, (id, value) => commands.push({ id, value }), value => options.push(value))
  const state = (presentation: PlaybackSnapshot['presentation'] = 'expanded', phase: PlaybackSnapshot['phase'] = 'playing', sessionId = 'one') =>
    ({ presentation, phase, sessionId } as PlaybackSnapshot)
  const move = (delta = -1) => { index += delta; return stack[index] }
  const pop = (delta = -1) => { history.pop(move(delta)) }
  return { playback, history, port, state, move, pop, commands, goes, options, marker: () => readOverlayHistoryMarker(stack[index]), length: () => stack.length }
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
for (const reload of [false, true]) for (const initial of [true, false]) test(`nested playback restoration across ${reload ? 'renderer reload' : 'panel remount'} when ${initial ? 'snapshot' : 'changed event'} arrives first`, () => {
  const f = fixture()
  f.playback.observe(f.state())
  let imageCloses = 0
  f.history.open('image-preview', () => { imageCloses++ })
  f.playback.abandon()
  const history = reload ? createOverlayHistory(f.port) : f.history
  const commands: unknown[] = []
  const restored = createPlaybackHistory(history, (id, value) => commands.push({ id, value }), () => {})
  restored.observe(f.state(), initial)
  restored.observe(f.state('fullscreen'))
  assert.equal(f.length(), 3, 'restoring and changing presentation cannot insert playback above the image')
  assert.equal(f.marker()?.kind, 'image-preview')
  history.pop(f.move())
  assert.equal(imageCloses, reload ? 0 : 1, 'reload must not revive the obsolete image callback')
  if (reload) {
    assert.deepEqual(commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }], 'the image UI did not survive reload: Back must dock without an empty step')
    restored.observe(f.state('docked'))
  } else assert.deepEqual(commands, [], 'closing a live image must preserve expanded playback')
  history.pop(f.move())
  assert.deepEqual(commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
  assert.deepEqual(f.commands, [], 'the old playback owner must remain abandoned')
  assert.deepEqual(f.goes, reload ? [-1] : [], 'only empty same-route history positions may be drained after reload')
})
test('navigation after restoring a nested player consumes the parent and image without stale commands', () => {
  const f = fixture()
  f.playback.observe(f.state())
  f.history.open('image-preview', () => {})
  f.playback.abandon()
  const restored = createPlaybackHistory(f.history, () => assert.fail('docking was already acknowledged'), () => {})
  restored.observe(f.state(), true)
  restored.closeForNavigation()
  assert.deepEqual(f.goes, [-2])
  f.pop(-2)
  assert.equal(f.marker(), null)
})
test('restoration during a child close reclaims the surviving parent and survives ordinary clock events', () => {
  const f = fixture()
  f.playback.observe(f.state())
  const parent = f.marker()?.token
  const image = f.history.open('image-preview', () => {})
  f.history.close(image)
  f.playback.abandon()
  const commands: unknown[] = []
  const restored = createPlaybackHistory(f.history, (id, value) => commands.push({ id, value }), () => {})
  restored.observe(f.state(), true)
  restored.observe(f.state('fullscreen'))
  assert.equal(f.length(), 3)
  f.pop()
  restored.observe(f.state('fullscreen'))
  assert.equal(f.marker()?.token, parent, 'restoration must not queue a replacement viewing entry')
  f.pop()
  assert.deepEqual(commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
  assert.deepEqual(f.commands, [])
  assert.deepEqual(f.goes, [-1])
})
test('abandoning a restoration during traversal never reclaims an obsolete callback', () => {
  const f = fixture()
  f.playback.observe(f.state())
  f.history.close(f.history.open('image-preview', () => {}))
  f.playback.abandon()
  const obsolete = createPlaybackHistory(f.history, () => assert.fail('obsolete restoration'), () => {})
  obsolete.observe(f.state(), true)
  obsolete.abandon()
  const current = createPlaybackHistory(f.history, (id, value) => f.commands.push({ id, value }), () => {})
  current.observe(f.state(), true)
  f.pop(); f.pop()
  assert.deepEqual(f.commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
})
for (const forward of [false, true]) test(`anonymous image parents do not leave an empty Back after ${forward ? 'Forward and reopening' : 'renderer reload'}`, () => {
  const f = fixture()
  f.history.open('image-preview', () => assert.fail('image did not survive reload'))
  f.playback.observe(f.state())
  f.playback.abandon()
  const history = createOverlayHistory(f.port)
  const commands: unknown[] = []
  const restored = createPlaybackHistory(history, (id, value) => commands.push({ id, value }), () => {})
  restored.observe(f.state(), true)
  history.pop(f.move())
  assert.deepEqual(commands, [{ id: 'one', value: { kind: 'presentation', value: 'docked' } }])
  assert.deepEqual(f.goes, [-1], 'consume the anonymous same-route parent in the same user action')
  history.pop(f.move())
  assert.equal(f.marker(), null)
  if (forward) {
    history.pop(f.move(2))
    restored.observe(f.state('docked'))
    restored.observe(f.state())
    history.pop(f.move())
    assert.deepEqual(f.goes, [-1, -1])
    history.pop(f.move())
    assert.equal(f.marker(), null)
    assert.equal(commands.length, 2)
  }
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
