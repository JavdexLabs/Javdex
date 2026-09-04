import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  arePendingScanAssignmentsComplete,
  arePendingScrapeSelectionsComplete,
  buildPendingQueueSections,
  defaultPendingScanPrimaryResourceId,
  pendingScanTargetFromValue,
  pendingScanTargetValue
} from './pendingCenterState'

describe('pending center resolution state', () => {
  it('requires every scan resource to have an explicit valid target', () => {
    const resources = [11, 12]

    assert.equal(arePendingScanAssignmentsComplete(resources, {}), false)
    assert.equal(
      arePendingScanAssignmentsComplete(resources, {
        11: { kind: 'existing', videoId: 7 }
      }),
      false
    )
    assert.equal(
      arePendingScanAssignmentsComplete(resources, {
        11: { kind: 'existing', videoId: 7 },
        12: { kind: 'new', groupKey: '1' }
      }),
      true
    )
  })

  it('serializes scan targets only at the select-control boundary', () => {
    assert.equal(pendingScanTargetValue(undefined), '')
    assert.equal(pendingScanTargetValue({ kind: 'existing', videoId: 7 }), 'existing:7')
    assert.equal(pendingScanTargetValue({ kind: 'new', groupKey: 'two' }), 'new:two')
    assert.deepEqual(pendingScanTargetFromValue('existing:7'), {
      kind: 'existing',
      videoId: 7
    })
    assert.deepEqual(pendingScanTargetFromValue('new:two'), {
      kind: 'new',
      groupKey: 'two'
    })
    assert.equal(pendingScanTargetFromValue('existing:0'), undefined)
    assert.equal(pendingScanTargetFromValue('invalid'), undefined)
  })

  it('starts scrape candidates unselected and rejects stale candidate ids', () => {
    const sources = [
      { id: 21, candidates: [{ id: 101 }, { id: 102 }] },
      { id: 22, candidates: [{ id: 201 }] }
    ]

    assert.equal(arePendingScrapeSelectionsComplete(sources, {}), false)
    assert.equal(
      arePendingScrapeSelectionsComplete(sources, { 21: 101, 22: 999 }),
      false
    )
    assert.equal(
      arePendingScrapeSelectionsComplete(sources, { 21: 102, 22: 201 }),
      true
    )
  })

  it('shows the same deterministic default primary ordering as persisted resolution', () => {
    const resource = (
      id: number,
      filePath: string,
      durationSeconds: number | null,
      sizeBytes: number | null
    ) => ({
      id,
      libraryId: 1,
      rootId: 1,
      groupId: 1,
      filePath,
      scanRoot: '/library',
      sourceKind: 'local' as const,
      targetKind: null,
      targetDisplay: null,
      durationSeconds,
      sizeBytes,
      fileMtimeMs: null,
      displayName: null
    })

    assert.equal(
      defaultPendingScanPrimaryResourceId([
        resource(1, '/library/z.mp4', 600, 1_000),
        resource(2, '/library/a.mp4', 900, 100)
      ]),
      2
    )
    assert.equal(
      defaultPendingScanPrimaryResourceId([
        resource(1, '/library/z.mp4', 900, 1_000),
        resource(2, '/library/a.mp4', 900, 2_000)
      ]),
      2
    )
    assert.equal(
      defaultPendingScanPrimaryResourceId([
        resource(1, '/library/z.mp4', 900, 2_000),
        resource(2, '/library/a.mp4', 900, 2_000)
      ]),
      2
    )
    assert.equal(defaultPendingScanPrimaryResourceId([]), null)
  })

  it('labels scan decisions with their owning media library', () => {
    const sections = buildPendingQueueSections(
      {
        scanGroups: [
          {
            id: 9,
            libraryId: 7,
            normalizedCode: 'ABC-123',
            revision: 1,
            createdAt: '2026-08-29T00:00:00.000Z',
            updatedAt: '2026-08-29T00:00:00.000Z',
            resources: []
          }
        ],
        scrapeItems: [],
        conflictGroups: [],
        libraryNames: new Map([[7, 'NAS 媒体库']])
      },
      'scan'
    )

    assert.equal(sections[0]?.items[0]?.meta, 'NAS 媒体库 · 0 条资源')
  })

  it('shows resource identity conflicts in the scan queue without exposing a local path', () => {
    const sections = buildPendingQueueSections(
      {
        scanGroups: [],
        resourceIdentities: [
          {
            id: 4,
            libraryId: 7,
            rootId: 2,
            sourceKind: 'local',
            targetKind: null,
            targetDisplay: null,
            displayName: 'FILE-001.mp4',
            filenameCode: 'FILE-001',
            nfoCode: 'NFO-002',
            revision: 1,
            createdAt: '2026-09-05T00:00:00.000Z',
            updatedAt: '2026-09-05T00:00:00.000Z'
          }
        ],
        scrapeItems: [],
        conflictGroups: [],
        libraryNames: new Map([[7, 'NAS 媒体库']])
      },
      'scan'
    )

    assert.deepEqual(sections[0]?.items[0], {
      key: { domain: 'scan', id: 'identity-4' },
      title: 'FILE-001 ↔ NFO-002',
      meta: 'NAS 媒体库 · FILE-001.mp4',
      coverPath: null,
      ready: false
    })
  })
})
