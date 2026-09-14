import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CatalogBackend } from '../application/catalogBackend'
import type { TargetListPage } from '@shared/protocol/tasks'
import {
  freezeRemoteVideoTargets,
  remoteActressTargetListInput,
  remoteVideoTargetListInput
} from './catalogRemoteBatch'
import { targetListRequestDigest } from '@library/catalog/catalogTargetLists'

describe('catalog remote batch freeze', () => {
  it('caps explicit remote video ids at 200 and hashes ids for digest', () => {
    assert.throws(
      () => remoteVideoTargetListInput({ status: 'all', videoIds: Array.from({ length: 201 }, (_, i) => i + 1) }),
      /远程已选影片不能超过 200 部/
    )
    const input = remoteVideoTargetListInput({ status: 'all', videoIds: [11, 12, 11] })
    assert.equal(input.kind, 'videos.ids')
    assert.deepEqual(input.ids, [11, 12])
    assert.equal(input.filterDigest, targetListRequestDigest({ kind: 'videos.ids', ids: [11, 12] }))
  })

  it('freezes actress filters without an ids payload', () => {
    const input = remoteActressTargetListInput({
      scope: 'female',
      scrapeStatus: 'unscraped',
      missingFields: ['avatar']
    })
    assert.equal(input.kind, 'actresses.filter')
    assert.deepEqual(input.actressFilter, {
      scope: 'female',
      scrapeStatus: 'unscraped',
      missingFields: ['avatar']
    })
    assert.equal(
      input.filterDigest,
      targetListRequestDigest({
        kind: 'actresses.filter',
        actressFilter: input.actressFilter
      })
    )
  })

  it('pages present entries only and never reads a local library', async () => {
    const created: unknown[] = []
    const backend = {
      tasks: {
        createTargetList: async (input: unknown) => {
          created.push(input)
          return { targetListId: 'list-1', count: 3 }
        },
        pageTargetList: async () =>
          ({
            targetListId: 'list-1',
            ids: [1, 2, 3],
            offset: 0,
            hasMore: false,
            entries: [
              { id: 1, present: true, label: 'A-001' },
              { id: 2, present: false, label: 'GONE' },
              { id: 3, present: true, label: 'A-003' }
            ]
          }) satisfies TargetListPage
      }
    } as unknown as CatalogBackend

    const targets = await freezeRemoteVideoTargets(backend, { status: 'all', videoIds: [1, 2, 3] })
    assert.deepEqual(targets, [
      { id: 1, code: 'A-001' },
      { id: 3, code: 'A-003' }
    ])
    assert.equal(created.length, 1)
  })
})
