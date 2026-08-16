import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLibraryScanSummary, sanitizeLibraryScanError } from './libraryScanSummary'

describe('sanitizeLibraryScanError', () => {
  it('removes HTTP credentials, query parameters, Magnet data, and ED2K targets', () => {
    const http = sanitizeLibraryScanError(
      'failed https://user:password@example.test/watch?id=42&token=secret#private'
    )
    const magnet = sanitizeLibraryScanError(
      'failed magnet:?xt=urn:btih:SECRET&dn=Private "Director\'s Cut"'
    )
    const ed2k = sanitizeLibraryScanError(
      'failed ed2k://|file|Private "Director\'s Cut".mp4|1024|ABCDEF0123456789ABCDEF0123456789|/'
    )

    assert.match(http, /https:\/\/example\.test\/watch/)
    assert.match(magnet, /magnet:/)
    assert.match(ed2k, /ed2k:/)
    assert.doesNotMatch(
      `${http}\n${magnet}\n${ed2k}`,
      /user|password|token|secret|private|director|cut|btih|abcdef/i
    )
  })

  it('bounds arbitrary errors and never throws while formatting them', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    assert.equal(sanitizeLibraryScanError(circular), '扫描失败')
    assert.equal(sanitizeLibraryScanError('x'.repeat(1000)).length, 500)
  })
})

describe('normalizeLibraryScanSummary', () => {
  it('persists completed STRM failures with safe messages and a 50-item bound', () => {
    const normalized = normalizeLibraryScanSummary({
      trigger: 'manual',
      startedAt: '2026-08-16T00:00:00.000Z',
      finishedAt: '2026-08-16T00:00:01.000Z',
      status: 'completed_with_errors',
      failedFiles: 55,
      strmFailures: Array.from({ length: 52 }, (_, index) => ({
        sourcePath: `/library/BAD-${index}.strm`,
        code: index === 0 ? 'multiple_targets' : 'read_failed',
        message: 'https://example.test/watch?token=secret'
      })),
      omittedStrmFailures: 3
    })

    assert.equal(normalized?.status, 'completed_with_errors')
    assert.equal(normalized?.strmFailures?.length, 50)
    assert.equal(normalized?.omittedStrmFailures, 5)
    assert.deepEqual(normalized?.strmFailures?.[0], {
      sourcePath: '/library/BAD-0.strm',
      code: 'multiple_targets',
      message: 'STRM 文件包含多个目标'
    })
    assert.doesNotMatch(JSON.stringify(normalized), /token|secret/)
  })
})
