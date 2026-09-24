import { it } from 'node:test'
import assert from 'node:assert/strict'
import { agentRunStore } from '../../agent-platform/agentRunStore'
import { AgentMetadataCollection } from './agentMetadataCollection'
import { AgentMetadataActivityTimeline } from './activityTimeline'
import type { CatalogBackend } from '../../application/catalogBackend'

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

it('describes a bound video through CatalogBackend and rejects an empty URL before Playwright', async () => {
  let getVideoCalls = 0
  const collection = new AgentMetadataCollection()
  collection.bindCatalog({
    queries: {
      getVideo: async (input: { videoId: number }) => {
        getVideoCalls += 1
        assert.equal(input.videoId, 7)
        return { id: 7, code: 'ABC-123' }
      }
    },
    actresses: {
      get: async () => {
        throw new Error('actress lookup must not run for a video target')
      }
    }
  } as unknown as CatalogBackend)
  await assert.rejects(
    () => collection.start({
      target: { kind: 'video', id: 7 },
      sourceUrl: '   ',
      idempotencyKey: 'm10-video'
    }),
    /请输入外部详情页 URL/
  )
  assert.equal(getVideoCalls, 1)
})

it('rejects a missing bound actress before opening Playwright', async () => {
  let actressCalls = 0
  const collection = new AgentMetadataCollection()
  collection.bindCatalog({
    queries: {
      getVideo: async () => {
        throw new Error('video lookup must not run for an actress target')
      }
    },
    actresses: {
      get: async (input: { actressId: number }) => {
        actressCalls += 1
        assert.equal(input.actressId, 3)
        return null
      }
    }
  } as unknown as CatalogBackend)
  await assert.rejects(
    () => collection.start({
      target: { kind: 'actress', id: 3 },
      sourceUrl: 'https://example.test/detail',
      idempotencyKey: 'm10-actress'
    }),
    /演员不存在/
  )
  assert.equal(actressCalls, 1)
})
