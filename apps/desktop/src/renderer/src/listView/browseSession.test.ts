import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowseSession } from './browseSession'

test('same-key return, newer requests, disabling and unmount all invalidate older replies', () => {
  const session = createBrowseSession('A')
  const first = session.begin('A')
  session.setScope('B'); session.setScope('A')
  assert.equal(session.isCurrent(first), false)
  const second = session.begin('A')
  const third = session.begin('A')
  assert.equal(session.isCurrent(second), false)
  assert.equal(session.isCurrent(third), true)
  session.setActive(false); session.setActive(true)
  assert.equal(session.isCurrent(third), false)
  const current = session.begin('A')
  session.begin('stale-scope')
  assert.equal(session.isCurrent(current), true, 'a stale callback cannot invalidate current work')
  session.setActive(false)
  assert.equal(session.isCurrent(session.begin('A')), false)
})
