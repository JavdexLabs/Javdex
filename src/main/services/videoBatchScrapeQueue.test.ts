import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PersistedBatchScrapeJob } from './batchScrapeJobStore'
import {
  assertVideoBatchResumeScope,
  formatVideoBatchScrapeOutcome,
  formatVideoBatchStatusLabel,
  validateVideoBatchTargetScope
} from './videoBatchScrapeQueue'

describe('videoBatchScrapeQueue feedback', () => {
  it('identifies scoped and global target sets in batch status text', () => {
    assert.equal(
      formatVideoBatchStatusLabel(
        { libraryId: 7, status: 0, fields: ['title'] },
        'Archive'
      ),
      '媒体库“Archive” · 未刮削'
    )
    assert.equal(
      formatVideoBatchStatusLabel({ status: 'all', fields: ['title'] }),
      '全局目录 · 全部影片'
    )
  })

  it('preserves and revalidates the original library scope when resuming a checkpoint', () => {
    const job: PersistedBatchScrapeJob = {
      jobId: 'scoped-video-job',
      kind: 'video',
      request: { libraryId: 7, status: 0, fields: ['title'] },
      targets: [
        { id: 1, label: 'DONE-001' },
        { id: 2, label: 'NEXT-002' }
      ],
      nextIndex: 1,
      success: 1,
      pending: 0,
      failed: 0,
      logs: [],
      total: 2,
      status: 'paused',
      updatedAt: '2026-08-29T00:00:00.000Z'
    }
    const filters: unknown[] = []

    assert.equal(
      assertVideoBatchResumeScope(job, (filter) => {
        filters.push(filter)
        return [{ id: 2, code: 'NEXT-002' }]
      }),
      job
    )
    assert.deepEqual(filters, [{ libraryId: 7, status: 'all', videoIds: [2] }])
    assert.throws(
      () => assertVideoBatchResumeScope(job, () => []),
      /当前媒体库作用域已变化/
    )
  })

  it('revalidates every frozen scoped target immediately before scraping', () => {
    const request = { libraryId: 7, status: 'all' as const, fields: ['title' as const] }
    const checks: Array<[number, number]> = []

    assert.equal(
      validateVideoBatchTargetScope(request, 11, (libraryId, videoId) => {
        checks.push([libraryId, videoId])
        return true
      }),
      null
    )
    assert.deepEqual(
      validateVideoBatchTargetScope(request, 12, (libraryId, videoId) => {
        checks.push([libraryId, videoId])
        return false
      }),
      {
        status: 'failure',
        level: 'error',
        message: '已跳过：影片已不属于当前活动媒体库（#7）'
      }
    )
    assert.deepEqual(checks, [
      [7, 11],
      [7, 12]
    ])

    let globalChecked = false
    assert.equal(
      validateVideoBatchTargetScope(
        { status: 'all', fields: ['title'] },
        13,
        () => {
          globalChecked = true
          return false
        }
      ),
      null
    )
    assert.equal(globalChecked, false)
  })

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
