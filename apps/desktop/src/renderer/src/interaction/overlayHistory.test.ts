import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOverlayHistory, readOverlayHistoryMarker, withOverlayHistoryMarker } from './overlayHistory'

function fixture() {
  const stack: Array<{ state: unknown; url: string }> = [{ state: { idx: 2, key: 'detail', usr: { from: 'library' } }, url: '#/detail' }]
  let index = 0, serial = 0
  const goes: number[] = [], closes: string[] = [], timers: (() => void)[] = []
  const history = createOverlayHistory({
    read: () => stack[index],
    push: (state, url) => { stack.splice(++index); stack.push({ state, url }) },
    go: delta => { goes.push(delta) },
    later: callback => { timers.push(callback); return () => {} },
    token: () => String(++serial)
  })
  const open = (kind: Parameters<typeof history.open>[0]) => history.open(kind, source => closes.push(`${kind}:${source}`))
  const move = (delta = -1) => { index += delta; return stack[index].state }
  const pop = (delta = -1) => { history.pop(move(delta)) }
  const route = (url: string) => {
    stack.splice(++index); stack.push({ state: { idx: 3, key: 'settings' }, url }); history.route()
  }
  return { history, stack, goes, closes, timers, open, move, pop, route, state: () => stack[index].state }
}
test('nested viewing layers retain router state and system back closes only the top without a second back', () => {
  const f = fixture()
  f.open('playback-expanded'); f.open('playback-fullscreen')
  assert.deepEqual((f.state() as { usr: unknown }).usr, { from: 'library' })
  assert.doesNotThrow(() => structuredClone(f.state()), 'only serializable markers enter browser history')
  assert.equal((f.state() as { idx: number }).idx, 2)
  f.pop()
  assert.deepEqual(f.closes, ['playback-fullscreen:history'])
  assert.deepEqual(f.goes, [])
  f.pop()
  assert.deepEqual(f.closes, ['playback-fullscreen:history', 'playback-expanded:history'])
})
test('explicit close consumes all owned children once, leaving no fullscreen or options placeholder', () => {
  const f = fixture()
  const expanded = f.open('playback-expanded')
  f.open('playback-options'); f.open('playback-fullscreen')
  f.history.close(expanded); f.history.close(expanded)
  assert.deepEqual(f.goes, [-3])
  f.pop(-3)
  assert.equal(readOverlayHistoryMarker(f.state()), null)
  assert.equal(f.closes.length, 3)
})
test('rapid close/open queues the new token until the old traversal arrives, including after fallback', () => {
  const f = fixture()
  const old = f.open('image-preview')
  f.history.close(old)
  const next = f.open('image-preview')
  f.timers[0]()
  assert.equal(f.stack.length, 2, 'cannot push before the in-flight back settles')
  assert.deepEqual(f.closes, ['image-preview:action'])
  f.pop()
  assert.equal(readOverlayHistoryMarker(f.state())?.token, next)
  assert.deepEqual(f.closes, ['image-preview:action'], 'the late old event cannot close the new preview')
  f.pop()
  assert.deepEqual(f.closes, ['image-preview:action', 'image-preview:history'])
})
test('a delayed old pop after fallback cannot close the queued preview or settle its traversal', () => {
  const f = fixture()
  const old = f.open('image-preview')
  f.history.close(old)
  const next = f.open('image-preview')
  const delayedState = f.move()
  f.timers[0]()
  assert.equal(readOverlayHistoryMarker(f.state())?.token, next)
  f.history.pop(delayedState)
  assert.deepEqual(f.closes, ['image-preview:action'], 'delivery is not another cursor movement')
  assert.equal(readOverlayHistoryMarker(f.state())?.token, next)
  f.history.close(next)
  f.history.pop(delayedState)
  assert.equal(f.history.isTraversing(), true, 'a stale event must not acknowledge the new back')
  f.pop()
  assert.equal(f.history.isTraversing(), false)
  assert.deepEqual(f.closes, ['image-preview:action', 'image-preview:action'])
  assert.deepEqual(f.goes, [-1, -1])
})
test('a genuine back still closes the preview after an old pop was ignored', () => {
  const f = fixture()
  const old = f.open('image-preview')
  f.history.close(old)
  const next = f.open('image-preview')
  const delayedState = f.move()
  f.timers[0]()
  f.history.pop(delayedState)
  assert.equal(readOverlayHistoryMarker(f.state())?.token, next)
  assert.deepEqual(f.closes, ['image-preview:action'])
  f.pop()
  assert.deepEqual(f.closes, ['image-preview:action', 'image-preview:history'])
  assert.deepEqual(f.goes, [-1])
})
test('closing the parent while a child traversal is in flight drains the parent before a new open', () => {
  const f = fixture()
  const expanded = f.open('playback-expanded')
  const fullscreen = f.open('playback-fullscreen')
  f.history.close(fullscreen)
  f.history.close(expanded)
  const image = f.open('image-preview')
  f.pop()
  assert.deepEqual(f.goes, [-1, -1])
  assert.equal(readOverlayHistoryMarker(f.state())?.token, expanded)
  f.pop()
  assert.equal(readOverlayHistoryMarker(f.state())?.token, image)
  assert.deepEqual(f.closes, ['playback-fullscreen:action', 'playback-expanded:action'])
})
test('image preview and playback share the same stack and abandonment does not navigate', () => {
  const f = fixture()
  const expanded = f.open('playback-expanded')
  f.open('image-preview'); f.pop()
  assert.deepEqual(f.closes, ['image-preview:history'])
  assert.equal(readOverlayHistoryMarker(f.state())?.token, expanded)
  f.history.abandon(expanded)
  assert.deepEqual(f.goes, [])
  f.pop()
  assert.equal(f.closes.length, 1)
})
test('markers do not contain sources or reuse an unrelated image marker', () => {
  const state = withOverlayHistoryMarker({ key: 'route' }, { kind: 'image-preview', token: 'image' })
  const next = withOverlayHistoryMarker(state, { kind: 'playback-expanded', token: 'player' })
  assert.equal(next.avImagePreview, undefined)
  assert.equal(next.key, 'route')
  assert.deepEqual(readOverlayHistoryMarker(next), { kind: 'playback-expanded', token: 'player' })
  assert.equal(readOverlayHistoryMarker({ avOverlay: { kind: 'unknown', token: 'bad' } }), null)
})
test('business navigation waits for the owned traversal, and cancelled waiters never run', () => {
  const f = fixture()
  const token = f.open('image-preview')
  f.history.close(token)
  const decisions: string[] = []
  const cancel = f.history.afterTraversal(() => decisions.push('cancelled'))
  f.history.afterTraversal(() => decisions.push('navigate'))
  cancel(); f.timers[0]()
  assert.deepEqual(decisions, [])
  assert.equal(f.history.isTraversing(), true)
  f.pop()
  assert.deepEqual(decisions, ['navigate'])
  assert.equal(f.history.isTraversing(), false)
  f.timers[0]()
  assert.deepEqual(decisions, ['navigate'], 'fallback never repeats a settled decision')
  assert.deepEqual(f.goes, [-1])
})
test('business route changes abandon viewing layers without going back or reopening on forward', () => {
  const f = fixture()
  f.open('playback-expanded'); f.open('image-preview')
  f.route('#/settings')
  assert.deepEqual(f.closes, ['image-preview:route', 'playback-expanded:route'])
  assert.deepEqual(f.goes, [])
  f.pop(-1)
  assert.equal(f.closes.length, 2, 'a stale historical marker cannot resurrect its view')
  f.pop(1)
  assert.equal(f.closes.length, 2)
})
