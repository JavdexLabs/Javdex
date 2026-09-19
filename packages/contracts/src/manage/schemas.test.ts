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

test('offline import needs operator confirmation and has no source permission operation', () => {
  const input = { migrationId: operationId, digest: 'a'.repeat(64) }
  assert.equal(parseManageInput('migration.enable', input).success, false)
  assert.equal(parseManageInput('migration.enable', { ...input, confirmSourceStopped: false }).success, false)
  assert.equal(parseManageInput('migration.enable', { ...input, confirmSourceStopped: true }).success, true)
  assert.equal(parseManageInput('migration.abandon', { ...input, confirmTargetStopped: true }).success, true)
  assert.equal('migration.allowEnable' in MANAGE_OPERATIONS, false)
})

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

test('C1-C7 contract expansions accept intended fields and reject unbounded dumps', () => {
  assert.equal(
    parseManageInput('pendingScan.queuePage', {
      libraryId: 3,
      anchor: { kind: 'group', id: 9 },
      limit: 50,
      offset: 0
    }).success,
    true
  )
  assert.equal(
    parseManageInput('pendingAudit.presence', {
      libraryId: 3,
      groupIds: [1, 2],
      identityIds: [4],
      scrapeIds: [8]
    }).success,
    true
  )
  assert.equal(
    parseManageInput('pendingAudit.presence', { libraryId: 3, groupIds: Array.from({ length: 101 }, (_, i) => i + 1) })
      .success,
    false
  )
  assert.equal(
    parseManageInput('scans.auditPage', {
      libraryId: 4,
      section: 'files',
      attention: true,
      limit: 20,
      offset: 5
    }).success,
    true
  )
  assert.equal(
    parseManageInput('scans.auditViewPage', {
      libraryId: 4,
      tab: 'failed',
      anchor: { kind: 'path', value: 'relative/ABC-001.mp4', rootId: 2 },
      limit: 20,
      offset: 0
    }).success,
    true
  )
  assert.equal(parseManageInput('videos.sources', { limit: 50, offset: 0 }).success, false)
  assert.equal(
    parseManageInput('videos.sources', {
      source: 'javlibrary',
      externalCode: 'ABC-001',
      limit: 50,
      offset: 0
    }).success,
    true
  )
  assert.equal(
    parseManageInput('files.renamePreview', {
      libraryId: 1,
      location: { rootId: 2, relativePath: 'clip.mp4' },
      newFileName: 'renamed.mp4'
    }).success,
    true
  )
  assert.equal(
    parseManageInput('files.rename', {
      libraryId: 1,
      location: { rootId: 2, relativePath: 'clip.mp4' },
      newFileName: 'renamed.mp4',
      planId: operationId,
      planDigest: 'a'.repeat(64)
    }).success,
    true
  )
  assert.equal(
    parseManageInput('playlists.applyImport', {
      name: 'list',
      videoIds: [11],
      libraryId: 1,
      videoLinks: [{ videoId: 11, label: 'source', url: 'https://example.test/abc-001' }]
    }).success,
    true
  )
  assert.equal(
    parseManageInput('targetLists.create', {
      kind: 'videos.ids',
      filterDigest: 'a'.repeat(64),
      ids: [1, 2]
    }).success,
    true
  )
  assert.equal(
    parseManageInput('targetLists.create', {
      kind: 'videos.filter',
      filterDigest: 'a'.repeat(64),
      videoFilter: { status: 0, missingFields: ['title'] }
    }).success,
    true
  )
  assert.equal(
    parseManageInput('pendingVideoScrapes.replace', {
      videoId: 8,
      selectedFields: ['title'],
      applicableFields: ['title'],
      updateMode: 'replace',
      sources: [
        {
          pluginName: 'Test',
          pluginSource: 'builtin',
          sourceName: 'Test',
          selectedFields: ['title'],
          candidates: [{ result: { code: 'ABC-001' } }]
        }
      ]
    }).success,
    true
  )
  assert.equal(
    parseManageInput('pendingVideoScrapes.existingIds', { scrapeIds: [1, 2] }).success,
    true
  )
  assert.equal(
    parseManageInput('pendingVideoScrapes.existingIds', { scrapeIds: [1], videoIds: [2] }).success,
    false
  )
})

test('scrape field queries validate entity fields and target counts are read-only', () => {
  assert.equal(MANAGE_OPERATIONS['targetLists.count'].auth, 'manageRead')
  assert.equal(MANAGE_OPERATIONS['scrape.fields'].auth, 'manageRead')
  assert.equal(parseManageInput('scrape.fields', {
    kind: 'actress', id: 1, fields: ['avatar']
  }).success, true)
  assert.equal(parseManageInput('scrape.fields', {
    kind: 'actress', id: 1, fields: ['title']
  }).success, false)
  assert.equal(parseManageInput('scrape.fields', {
    kind: 'video', id: 1, fields: ['source'], sourceName: 'Site'
  }).success, true)
  assert.equal(parseManageInput('targetLists.count', {
    kind: 'videos.ids', ids: Array.from({ length: 201 }, (_, i) => i + 1), filterDigest: 'a'.repeat(64)
  }).success, false)
})


test('resource import supports metadata-only registration and multiple resources from desktop', () => {
  const base = { libraryId: 1, code: 'TEST-001', target: { kind: 'new' } }
  assert.equal(parseManageInput('videos.importResource', base).success, true)
  const input = {
    ...base,
    resources: [{ url: 'https://example.test/video.mp4', kind: 'direct' }],
    links: [{ label: 'Details', url: 'https://example.test/details' }]
  }
  const parsed = parseManageInput('videos.importResource', input)
  assert.equal(parsed.success, true)
  if (parsed.success) assert.deepEqual(parsed.data, input)
  assert.equal(parseManageInput('videos.importResource', {
    ...input, resources: Array.from({ length: 21 }, () => input.resources[0])
  }).success, false)
  assert.equal(parseManageInput('videos.importResource', {
    ...input, resources: [{ url: 'https://example.test/video.mp4', sourcePath: '/private/video.mp4' }]
  }).success, false)
})
