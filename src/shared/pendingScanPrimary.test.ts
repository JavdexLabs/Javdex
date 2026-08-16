import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { selectDefaultPendingScanPrimary } from './pendingScanPrimary'

describe('selectDefaultPendingScanPrimary', () => {
  it('prefers local resources and keeps duration, size, and path ordering', () => {
    const resources = [
      {
        id: 1,
        filePath: '/library/A.strm',
        sourceKind: 'strm' as const,
        targetKind: 'direct' as const,
        durationSeconds: null,
        sizeBytes: null
      },
      {
        id: 2,
        filePath: '/library/B.mp4',
        sourceKind: 'local' as const,
        targetKind: null,
        durationSeconds: 3600,
        sizeBytes: 100
      },
      {
        id: 3,
        filePath: '/library/C.mp4',
        sourceKind: 'local' as const,
        targetKind: null,
        durationSeconds: 3600,
        sizeBytes: 200
      }
    ]

    assert.equal(selectDefaultPendingScanPrimary(resources, (value) => value)?.id, 3)
  })

  it('orders STRM resources by actual target kind and then source path', () => {
    const resources = [
      ['web', '/library/A.strm'],
      ['ed2k', '/library/B.strm'],
      ['magnet', '/library/C.strm'],
      ['direct', '/library/Z.strm'],
      ['direct', '/library/A.strm']
    ].map(([targetKind, filePath], id) => ({
      id,
      filePath,
      sourceKind: 'strm' as const,
      targetKind: targetKind as 'direct' | 'web' | 'magnet' | 'ed2k',
      durationSeconds: null,
      sizeBytes: null
    }))

    assert.equal(selectDefaultPendingScanPrimary(resources, (value) => value)?.id, 4)
  })
})
