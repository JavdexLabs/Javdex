import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatVideoBatchScrapeOutcome } from './videoBatchScrapeQueue'

describe('videoBatchScrapeQueue feedback', () => {
  it('formats success, skip, and partial-warning outcomes distinctly', () => {
    assert.deepEqual(
      formatVideoBatchScrapeOutcome({ ok: true, result: { code: 'A', title: 'Title' } }, 'A'),
      { status: 'success', level: 'success', message: '更新成功：Title' }
    )
    assert.deepEqual(
      formatVideoBatchScrapeOutcome(
        { ok: true, result: { code: 'B' }, skipped: true, warnings: [] },
        'B'
      ),
      { status: 'success', level: 'info', message: '跳过：所选字段无可写入内容' }
    )
    assert.deepEqual(
      formatVideoBatchScrapeOutcome(
        { ok: true, result: { code: 'C' }, warnings: ['封面下载失败，已保留原封面'] },
        'C'
      ),
      {
        status: 'success',
        level: 'info',
        message: '更新成功，部分图片未应用：C（封面下载失败，已保留原封面）'
      }
    )
  })
})
