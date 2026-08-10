import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getVideoResourceBadgeSummary
} from './videoResourceBadges'
import {
  VIDEO_RESOURCE_FILTER_LABELS,
  VIDEO_RESOURCE_KIND_LABELS
} from './videoResourcePresentation'

describe('video resource card badges', () => {
  it('keeps primary-first order, deduplicates kinds, and limits visible labels to two', () => {
    assert.deepEqual(
      getVideoResourceBadgeSummary(['web', 'local', 'direct', 'web', 'magnet']),
      {
        visible: [
          { kind: 'web', label: '网页' },
          { kind: 'local', label: '本地' }
        ],
        overflow: 2,
        title: '网页、本地、直链、Magnet'
      }
    )
  })

  it('returns no card decoration when a video has no resources', () => {
    assert.deepEqual(getVideoResourceBadgeSummary([]), {
      visible: [],
      overflow: 0,
      title: ''
    })
  })

  it('shares full resource labels across detail and filter surfaces', () => {
    assert.equal(VIDEO_RESOURCE_KIND_LABELS.local, '本地文件')
    assert.equal(VIDEO_RESOURCE_KIND_LABELS.direct, '视频直链')
    assert.equal(VIDEO_RESOURCE_FILTER_LABELS.web, '网页链接')
    assert.equal(VIDEO_RESOURCE_FILTER_LABELS.none, '无资源')
  })
})
