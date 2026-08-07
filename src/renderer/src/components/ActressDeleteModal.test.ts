import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  actressDeleteConfirmationCopy,
  actressDeleteModeForAction
} from './actressDeleteConfirmation'

describe('ActressDeleteModal confirmation model', () => {
  it('uses ordinary deletion only when the current impact has no video links', () => {
    const copy = actressDeleteConfirmationCopy(
      { actressCount: 2, linkedActressCount: 0, affectedVideoCount: 0 },
      '已选择的 2 位演员'
    )

    assert.equal(copy.highRisk, false)
    assert.equal(copy.confirmText, '删除')
    assert.match(copy.description, /均未关联影片/)
  })

  it('requires the dedicated acknowledgement action and explains file preservation', () => {
    const impact = { actressCount: 2, linkedActressCount: 1, affectedVideoCount: 3 }
    const copy = actressDeleteConfirmationCopy(
      impact,
      '已选择的 2 位演员'
    )

    assert.equal(copy.highRisk, true)
    assert.equal(copy.confirmText, '我已了解，仍要删除')
    assert.match(copy.description, /解除这些关联/)
    assert.match(copy.description, /不会删除影片文件/)
    assert.equal(actressDeleteModeForAction(impact, 'cancel'), null)
    assert.equal(actressDeleteModeForAction(impact, 'ordinary-confirm'), null)
    assert.equal(
      actressDeleteModeForAction(impact, 'acknowledge-risk'),
      'unlink-videos-and-delete'
    )
  })

  it('does not let the dedicated high-risk action bypass the safe path', () => {
    const impact = { actressCount: 1, linkedActressCount: 0, affectedVideoCount: 0 }

    assert.equal(actressDeleteModeForAction(impact, 'cancel'), null)
    assert.equal(actressDeleteModeForAction(impact, 'acknowledge-risk'), null)
    assert.equal(actressDeleteModeForAction(impact, 'ordinary-confirm'), 'only-unlinked')
  })
})
