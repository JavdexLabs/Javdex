import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getActressFaceScanSession,
  getActressFaceScanSessionRevision,
  resetActressFaceScanSession,
  subscribeActressFaceScanSession,
  updateActressFaceScanSession
} from './session'

describe('actress face scan session', () => {
  it('notifies remounted consumers when an earlier scan finishes', () => {
    resetActressFaceScanSession()
    const revisions: number[] = []
    const unsubscribe = subscribeActressFaceScanSession(() => {
      revisions.push(getActressFaceScanSessionRevision())
    })

    updateActressFaceScanSession({ running: true, runSequence: 1 })
    updateActressFaceScanSession({ needsScan: true, running: false })
    unsubscribe()

    assert.equal(revisions.length, 2)
    assert.equal(getActressFaceScanSession().running, false)
    assert.equal(getActressFaceScanSession().needsScan, true)
  })
})
