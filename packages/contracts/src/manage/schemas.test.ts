import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MANAGE_OPERATIONS, type ManageOperationId } from './operations'
import { MANAGE_OPERATION_INPUTS } from './inputs'
import { parseManageInput, parseManageRequest } from './parse'
import { JSON_REQUEST_MAX_BYTES, PAGE_SIZE_MAX, UPLOAD_STREAM_MAX_BYTES } from '../protocol/limits'
import { jsonRequestByteLimit } from './primitives'

const operationId = '11111111-1111-4111-8111-111111111111'
const serverId = '22222222-2222-4222-8222-222222222222'
const catalogId = '33333333-3333-4333-8333-333333333333'
const version = { generation: 1, revision: 4 }

test('every manage operation has matching metadata and a strict input schema', () => {
  const operations = Object.keys(MANAGE_OPERATIONS) as ManageOperationId[]
  assert.equal(operations.length, Object.keys(MANAGE_OPERATION_INPUTS).length)
  for (const operation of operations) {
    assert.equal(MANAGE_OPERATION_INPUTS[operation].safeParse({ unexpected: true }).success, false, operation)
  }
})

test('video poster rejects desktop paths and unknown fields', () => {
  assert.equal(
    parseManageInput('videos.setPoster', {
      videoId: 1,
      image: { kind: 'upload', uploadId: operationId }
    }).success,
    true
  )
  assert.equal(
    parseManageInput('videos.setPoster', {
      videoId: 1,
      posterPath: 'C:\\covers\\a.jpg'
    }).success,
    false
  )
  assert.equal(
    parseManageInput('videos.setPoster', {
      videoId: 1,
      image: { kind: 'upload', uploadId: operationId },
      extra: true
    }).success,
    false
  )
})

test('manual file import rejects absolute host paths', () => {
  assert.equal(
    parseManageInput('files.importManual', {
      libraryId: 1,
      location: { rootId: 9, relativePath: 'new\\clip.mp4' },
      code: 'ABC-001',
      target: { kind: 'new' }
    }).success,
    true
  )
  assert.equal(
    parseManageInput('files.importManual', {
      libraryId: 1,
      path: 'D:\\media\\clip.mp4',
      code: 'ABC-001',
      target: { kind: 'new' }
    }).success,
    false
  )
})

test('manage writes require writer identity and reject browser cookies as a substitute', () => {
  const parsed = parseManageRequest('videos.edit', {
    operationId,
    serverId,
    catalogId,
    writerEpoch: 3,
    expectedVersions: { V: version },
    input: { videoId: 8, fields: { title: '标题' } }
  })
  assert.equal(parsed.success, true)
  const withoutWriter = parseManageRequest('videos.edit', {
    operationId,
    serverId,
    catalogId,
    expectedVersions: { V: version },
    input: { videoId: 8, fields: { title: '标题' } }
  })
  assert.equal(withoutWriter.success, false)
  const browserCookie = parseManageRequest('videos.edit', {
    cookie: 'browser-session',
    input: { videoId: 8, fields: { title: '标题' } }
  })
  assert.equal(browserCookie.success, false)
})

test('manage reads still require catalog identity and reject extra fields', () => {
  const ok = parseManageRequest('videos.list', {
    serverId,
    catalogId,
    input: { scope: { kind: 'library', libraryId: 1 }, query: { limit: 50 } }
  })
  assert.equal(ok.success, true)
  const extra = parseManageRequest('videos.list', {
    serverId,
    catalogId,
    writerToken: 'secret',
    input: { scope: { kind: 'library', libraryId: 1 } }
  })
  assert.equal(extra.success, false)
})

test('pagination and upload limits reject oversized values instead of truncating', () => {
  assert.equal(
    parseManageInput('videos.list', {
      scope: { kind: 'library', libraryId: 1 },
      query: { limit: PAGE_SIZE_MAX + 1 }
    }).success,
    false
  )
  assert.equal(
    parseManageInput('videos.list', {
      scope: { kind: 'all', libraryIds: Array.from({ length: 201 }, (_, index) => index + 1) }
    }).success,
    false
  )
  assert.equal(UPLOAD_STREAM_MAX_BYTES, 32 * 1024 * 1024)
  assert.equal(
    jsonRequestByteLimit('{"title":"x"}', JSON_REQUEST_MAX_BYTES),
    true
  )
  assert.equal(jsonRequestByteLimit('x'.repeat(JSON_REQUEST_MAX_BYTES + 1), JSON_REQUEST_MAX_BYTES), false)
})

test('correct-import requires an explicit pending-scrape choice', () => {
  assert.equal(
    parseManageInput('videos.correctImport', { videoId: 1, code: 'ABC-001' }).success,
    false
  )
  assert.equal(
    parseManageInput('videos.correctImport', {
      videoId: 1,
      code: 'ABC-001',
      discardPendingScrape: true
    }).success,
    true
  )
})
