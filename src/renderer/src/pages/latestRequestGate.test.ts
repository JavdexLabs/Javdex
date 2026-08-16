import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLatestRequestGate } from './latestRequestGate'

describe('conflict review latest request gate', () => {
  it('accepts only the newest async validation result', () => {
    const gate = createLatestRequestGate()
    const first = gate.next()
    const second = gate.next()

    assert.equal(gate.isLatest(first), false)
    assert.equal(gate.isLatest(second), true)
  })

  it('invalidates an in-flight result when the workflow closes', () => {
    const gate = createLatestRequestGate()
    const request = gate.next()
    gate.invalidate(request)

    assert.equal(gate.isLatest(request), false)
  })

  it('does not let stale cleanup invalidate the current request', () => {
    const gate = createLatestRequestGate()
    const first = gate.next()
    const second = gate.next()
    gate.invalidate(first)

    assert.equal(gate.isLatest(second), true)
  })
})
