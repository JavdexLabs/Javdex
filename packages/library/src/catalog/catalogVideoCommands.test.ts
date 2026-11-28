import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { ensureCatalogIdentity } from './catalogIdentity'
import { catalogVideoCommands, listTranslationTargets } from './catalogVideoCommands'
import { readVideoAggregateVersion } from './catalogAggregateVersion'

let directory: string | undefined
afterEach(() => {
  closeDatabase()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
  delete process.env.JAVDEX_TEST_USER_DATA
})

function fixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-command-'))
  process.env.JAVDEX_TEST_USER_DATA = directory
  initDatabaseAtPath(path.join(directory, 'library.db'))
  ensureCatalogIdentity()
  const videoId = Number(getDb().prepare("INSERT INTO videos(code,title) VALUES ('ABC-001','before')").run().lastInsertRowid)
  return { videoId, context: { operationId: randomUUID(), writerEpoch: 0, expectedVersions: { V: readVideoAggregateVersion(videoId)! } } }
}

it('edits through one versioned receipt and replays without writing twice', () => {
  const { videoId, context } = fixture()
  const input = { videoId, fields: { title: 'after' } }
  const first = catalogVideoCommands.edit(input, context)
  assert.equal(first.data.ok, true)
  assert.equal(first.outcome, 'applied')
  const replay = catalogVideoCommands.edit(input, context)
  assert.equal(replay.outcome, 'duplicate')
  assert.deepEqual(replay.data, first.data)
  assert.deepEqual(readVideoAggregateVersion(videoId), first.data.versions.V)
  assert.throws(() => catalogVideoCommands.edit({ videoId, fields: { title: 'stale' } }, { ...context, operationId: randomUUID() }),
    (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
})

it('retains unversioned desktop status writes but requires server versions', () => {
  const { videoId } = fixture()
  const context = { operationId: randomUUID(), writerEpoch: 0, expectedVersions: {} }
  assert.throws(() => catalogVideoCommands.markScrapeSuccess({ videoId }, context),
    (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT')
  assert.equal(catalogVideoCommands.markScrapeSuccess({ videoId }, { ...context, operationId: randomUUID() }, true).data.ok, true)
})

it('legacy desktop calls still reject a supplied stale version', () => {
  const { videoId, context } = fixture()
  catalogVideoCommands.setRating({ videoId, rating: 4 }, context)
  assert.throws(() => catalogVideoCommands.clearMeta({ videoId }, { ...context, operationId: randomUUID() }, true),
    (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
})

it('applies matching translation fields, preserves scrape state, and replays the same receipt', () => {
  const { videoId, context } = fixture()
  const db = getDb()
  const libraryId = Number(db.prepare("INSERT INTO media_libraries(name) VALUES ('Translation fixture')").run().lastInsertRowid)
  db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES (?, ?, 0)').run(libraryId, videoId)
  db.prepare("UPDATE videos SET title=NULL, summary='description', scraped_status=2, rating=4 WHERE id=?").run(videoId)
  const generation = context.expectedVersions.V.generation
  assert.deepEqual(listTranslationTargets({ libraryId, videoIds: [videoId] }), [{ id: videoId, generation, code: 'ABC-001' }])
  const input = { catalogId: 'fixture', serverId: null, libraryId, videoId, generation, fields: {
    title: { original: 'before', translation: '标题' },
    summary: { original: 'description', translation: '简介' }
  } }
  const result = catalogVideoCommands.applyTranslation(input, { ...context, expectedVersions: {} })
  assert.deepEqual(result.data.fields, { title: 'conflict', summary: 'applied' })
  assert.deepEqual(db.prepare('SELECT title, summary, scraped_status, rating FROM videos WHERE id=?').get(videoId),
    { title: null, summary: '简介', scraped_status: 2, rating: 4 })
  assert.deepEqual(catalogVideoCommands.applyTranslation(input, { ...context, expectedVersions: {} }).data, result.data)
  assert.equal(readVideoAggregateVersion(videoId)!.revision, context.expectedVersions.V.revision + 1)

  db.prepare(`INSERT INTO pending_video_scrapes(video_id,selected_fields_json,applicable_fields_json,update_mode,request_json,warnings_json,created_at,updated_at)
    VALUES(?, '[]', '[]', 'replace', '{}', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(videoId)
  const locked = catalogVideoCommands.applyTranslation({ ...input, fields: { summary: { original: '简介', translation: '新译文' } } },
    { ...context, operationId: randomUUID(), expectedVersions: {} })
  assert.deepEqual(locked.data.fields, { summary: 'locked' })
  db.prepare('DELETE FROM library_video_memberships WHERE library_id=? AND video_id=?').run(libraryId, videoId)
  assert.deepEqual(listTranslationTargets({ libraryId, videoIds: [videoId] }), [])
  assert.deepEqual(catalogVideoCommands.applyTranslation(input, { ...context, operationId: randomUUID(), expectedVersions: {} }).data.fields,
    { title: 'out-of-scope', summary: 'out-of-scope' })
})
