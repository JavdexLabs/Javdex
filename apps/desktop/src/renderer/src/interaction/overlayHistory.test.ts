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
    replace: (state, url) => { stack[index] = { state, url } },
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

for (const kind of ['playback-expanded', 'image-preview'] as const) test(`reopening ${kind} after Forward does not leave an empty Back step`, () => {
  const f = fixture()
  const retired = f.open(kind)
  f.pop()
  f.pop(1)
  assert.equal(readOverlayHistoryMarker(f.state())?.token, retired)
  const current = f.open(kind)
  assert.equal(readOverlayHistoryMarker(f.state())?.token, current)
  assert.equal((f.state() as { key: string }).key, 'detail')
  assert.equal((f.state() as { idx: number }).idx, 2)
  assert.deepEqual((f.state() as { usr: unknown }).usr, { from: 'library' })
  f.pop()
  assert.equal(readOverlayHistoryMarker(f.state()), null, 'Back should return to the business entry, not a retired playback placeholder')
  assert.deepEqual(f.closes, [`${kind}:history`, `${kind}:history`])
  assert.deepEqual(f.goes, [], 'system Back must not trigger a second traversal')
})

test('adopting an abandoned current marker restores only its callback without writing router history', () => {
  const f = fixture()
  const token = f.open('playback-expanded')
  f.history.abandon(token)
  const state = f.state()
  const closes: string[] = []
  assert.equal(f.history.adopt('playback-expanded', source => closes.push(source)), token)
  assert.equal(f.state(), state)
  assert.equal(f.stack.length, 2)
  assert.deepEqual(f.goes, [])
  f.pop()
  assert.deepEqual(closes, ['history'])
  assert.deepEqual(f.closes, [], 'the abandoned callback must never run')
})

test('adoption cannot invent a marker, steal another kind or replace a live callback', () => {
  const f = fixture()
  const obsolete = () => assert.fail('adoption must not take ownership')
  assert.equal(f.history.adopt('playback-expanded', obsolete), null)
  f.open('image-preview')
  const state = f.state()
  assert.equal(f.history.adopt('playback-expanded', obsolete), null)
  assert.equal(f.history.adopt('image-preview', obsolete), null)
  assert.equal(f.state(), state)
  assert.equal(f.stack.length, 2)
  assert.deepEqual(f.goes, [])
  f.pop()
  assert.deepEqual(f.closes, ['image-preview:history'])
})

test('adoption cannot reclaim a marker while its close traversal is in flight', () => {
  const f = fixture()
  const token = f.open('playback-expanded')
  f.history.close(token)
  f.history.abandon(token)
  assert.equal(f.history.adopt('playback-expanded', () => assert.fail('closing layer cannot be restored')), null)
  assert.deepEqual(f.goes, [-1])
  f.pop()
  assert.equal(f.history.isTraversing(), false)
  assert.deepEqual(f.closes, ['playback-expanded:action'])
})

test('nested history serializes anonymous positions, not callbacks or viewing data', () => {
  const f = fixture()
  f.open('playback-expanded'); f.open('image-preview')
  const state = structuredClone(f.state()) as Record<string, unknown>
  assert.deepEqual(state.avOverlayParents, [{ kind: 'playback-expanded', token: '1' }])
  assert.deepEqual((state.avOverlay as object), { kind: 'image-preview', token: '2' })
  const restored = createOverlayHistory({ read: () => ({ state, url: '#/detail' }),
    push: () => assert.fail('restoration cannot push'), replace: () => assert.fail('restoration cannot replace'),
    go: () => assert.fail('restoration cannot traverse'), later: () => () => {}, token: () => 'unused' })
  assert.equal(restored.adopt('playback-expanded', () => {}), '1')
  assert.equal(restored.adopt('playback-expanded', () => assert.fail('live owner must not be replaced')), null)
})
test('invalid or duplicated parent trails cannot create restorable viewing positions', () => {
  for (const parents of [[{ kind: 'unknown', token: 'parent' }], [{ kind: 'playback-expanded', token: 'top' }],
    Array.from({ length: 65 }, (_, index) => ({ kind: 'playback-expanded', token: String(index) }))]) {
    const state = { avOverlay: { kind: 'image-preview', token: 'top' }, avOverlayParents: parents }
    const history = createOverlayHistory({ read: () => ({ state, url: '#/detail' }), push: () => {}, replace: () => {},
      go: () => assert.fail('invalid metadata cannot navigate'), later: () => () => {}, token: () => 'unused' })
    assert.equal(history.adopt('playback-expanded', () => assert.fail('invalid parent cannot own a callback')), null)
  }
})
test('nested adoption never steals a live lower owner and abandoned queued entries never open', () => {
  const f = fixture()
  f.open('playback-expanded'); f.open('image-preview')
  assert.equal(f.history.adopt('playback-expanded', () => assert.fail('live lower owner cannot be replaced')), null)
  f.pop(); f.pop()
  assert.deepEqual(f.closes, ['image-preview:history', 'playback-expanded:history'])
  const closing = f.open('image-preview')
  f.history.close(closing)
  const queued = f.open('playback-expanded')
  f.history.abandon(queued)
  f.pop()
  assert.equal(readOverlayHistoryMarker(f.state()), null)
})
