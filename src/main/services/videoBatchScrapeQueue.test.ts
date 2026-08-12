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
        message: '更新成功，部分字段未应用：C（封面下载失败，已保留原封面）'
      }
    )
    assert.deepEqual(
      formatVideoBatchScrapeOutcome(
        {
          ok: true,
          result: { code: 'D', title: 'Safe title' },
          warnings: ['导演“同名导演”匹配到 2 个候选，已保留现有关联；请先手动选择或合并重复导演']
        },
        'D'
      ),
      {
        status: 'success',
        level: 'info',
        message:
          '更新成功，部分字段未应用：Safe title（导演“同名导演”匹配到 2 个候选，已保留现有关联；请先手动选择或合并重复导演）'
      }
    )
  })

  it('counts a persisted multi-candidate result as pending instead of success or failure', () => {
    assert.deepEqual(
      formatVideoBatchScrapeOutcome(
        { ok: true, pending: true, pendingScrapeId: 7, skipped: true },
        'PEND-001'
      ),
      {
        status: 'pending',
        level: 'info',
        message: '待确认：已保存全部匹配候选，可稍后在待确认中心处理'
      }
    )
  })
})
