import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  organizationMergeSuccessMessage,
  organizationRoleSummary,
  organizationVideoBreakdown
} from './organizationMergePresentation'

describe('organization merge presentation', () => {
  it('shows cross-role candidate statistics without collapsing the two roles', () => {
    assert.equal(organizationRoleSummary(['maker', 'publisher']), '制作商 / 发行商')
    assert.equal(
      organizationVideoBreakdown({ makerVideoCount: 3, publisherVideoCount: 5 }),
      '制作 3 部 · 发行 5 部'
    )
  })

  it('reports each transferred relation after a successful merge', () => {
    assert.equal(
      organizationMergeSuccessMessage({
        targetId: 1,
        sourceId: 2,
        transferredMakerVideoCount: 3,
        transferredPublisherVideoCount: 5,
        transferredChildCount: 2,
        transferredSeriesCount: 4,
        imagePath: null,
        cleanupFailures: []
      }),
      '机构已合并：制作商影片 3 部，发行商影片 5 部，子机构 2 个，系列 4 个'
    )
  })
})
