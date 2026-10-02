import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowseAnchorMemory, retainBrowsePages } from './browseWindow'

test('visible pages lead, caches are bounded, exact total shrink clamps stale offsets', () => {
  assert.deepEqual(retainBrowsePages(210, 520, 100, [0, 100]), [200, 300, 400])
  assert.deepEqual(retainBrowsePages(610, 630, 100, [0, 100, 200], 125), [100, 0])
  assert.deepEqual(retainBrowsePages(0, 0, 100, [500], 0), [0])
  assert.deepEqual(retainBrowsePages(310, 320, 100, [0, 100, 200]), [300, 0, 100])
  assert.deepEqual(retainBrowsePages(NaN, 0, 100, [0]), [0])
  assert.throws(() => retainBrowsePages(0, 10, 0, []))
})

test('light anchors have a twenty-session LRU bound, without caching page DTOs', () => {
  const memory = createBrowseAnchorMemory<number>()
  for (let i = 0; i < 20; i++) memory.remember(String(i), i)
  memory.remember('0', 100)
  memory.remember('20', 20)
  assert.equal(memory.get('1'), undefined)
  assert.equal(memory.get('0'), 100)
  memory.clear()
  assert.equal(memory.get('0'), undefined)
})
