import { it } from 'node:test'
import assert from 'node:assert/strict'
import { agentRunStore } from '../../agent-platform/agentRunStore'
import { AgentMetadataCollection } from './agentMetadataCollection'
import { AgentMetadataActivityTimeline } from './activityTimeline'

it('uses the indexed journal cursor without loading history for a metadata snapshot', (t) => {
  const collection = new AgentMetadataCollection()
  const active = (collection as unknown as { active: Map<string, unknown> }).active
  active.set('metadata-cursor', {
    state: { revision: 2, target: { kind: 'video', id: 1 }, phase: 'collecting', summary: 'collecting' },
    timeline: new AgentMetadataActivityTimeline()
  })
  const cursor = t.mock.method(agentRunStore, 'getProductJournalCursor', () => 34567)
  t.mock.method(agentRunStore, 'readProductJournal', () => { throw new Error('snapshot must not load the journal') })
  try {
    const snapshot = collection.snapshot('metadata-cursor')
    assert.equal(snapshot?.cursor, 34567)
    assert.equal(snapshot?.revision, 2)
    assert.deepEqual(snapshot?.activities, [])
    assert.equal(cursor.mock.callCount(), 1)
    assert.equal(cursor.mock.calls[0].arguments[0], 'metadata-cursor')
  } finally { t.mock.restoreAll() }
})
