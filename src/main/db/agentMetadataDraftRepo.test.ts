import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AgentMetadataReview } from '@shared/agentMetadataTypes'
import { migrateDatabase } from './migrations'
import { AgentMetadataDraftRepo } from './agentMetadataDraftRepo'

function fixture() {
  const db = new Database(':memory:')
  migrateDatabase(db)
  db.prepare(
    `INSERT INTO agent_runs (
       id, use_case, status, config_revision, config_snapshot_json, runtime_id,
       product_state_json, created_at, updated_at
     ) VALUES (?, 'metadata-collector', 'running', 'test', '{}', 'pi', '{}', ?, ?)`
  ).run('run-1', new Date().toISOString(), new Date().toISOString())
  db.exec("INSERT INTO videos (id, code) VALUES (7, 'ABC-123'), (8, 'XYZ-008')")
  return { db, repo: new AgentMetadataDraftRepo(() => db) }
}

function createVideoDraft(
  repo: AgentMetadataDraftRepo,
  id: string,
  stagedPath: string,
  targetId = 7
) {
  return repo.create({
    id,
    runId: 'run-1',
    target: { kind: 'video', id: targetId },
    source: {
      requestedUrl: 'https://example.test/video/ABC-123',
      finalUrl: 'https://example.test/video/ABC-123',
      displayUrl: 'https://example.test/video/ABC-123',
      sourceName: 'example.test'
    },
    payload: {
      kind: 'video',
      result: { code: 'ABC-123', title: 'Candidate' },
      observedFields: ['title'],
      explicitlyEmptyFields: [],
      evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
    },
    resources: [{
      field: 'cover',
      position: 0,
      remoteUrl: 'https://cdn.example.test/cover.jpg',
      stagedPath,
      width: 640,
      height: 480,
      sizeBytes: 1024,
      sha256: 'a'.repeat(64)
    }],
    warnings: []
  })
}

describe('AgentMetadataDraftRepo', () => {
  it('keeps one ready draft per target and returns superseded staging paths', () => {
    const { db, repo } = fixture()
    try {
      createVideoDraft(repo, 'draft-1', '.video_scrape_staging/one/cover-0.jpg')
      const second = createVideoDraft(repo, 'draft-2', '.video_scrape_staging/two/cover-0.jpg')

      assert.deepEqual(second.supersededStagedPaths, ['.video_scrape_staging/one/cover-0.jpg'])
      assert.equal(repo.require('draft-1').status, 'discarded')
      assert.equal(repo.findReadyForTarget({ kind: 'video', id: 7 })?.id, 'draft-2')
    } finally {
      db.close()
    }
  })

  it('advances review revisions and stores an idempotent terminal outcome', () => {
    const { db, repo } = fixture()
    try {
      const draft = createVideoDraft(repo, 'draft-1', '.video_scrape_staging/one/cover-0.jpg').draft
      const review: AgentMetadataReview = {
        kind: 'video',
        draftId: draft.id,
        revision: 2,
        token: 'review-token',
        selection: {
          kind: 'video',
          draftId: draft.id,
          expectedRevision: 2,
          fields: ['title'],
          mode: 'fillEmpty'
        },
        impacts: [],
        warnings: [],
        classifications: [],
        canApply: true
      }
      repo.saveReview({ draftId: draft.id, expectedRevision: 1, review })
      assert.throws(
        () => repo.saveReview({ draftId: draft.id, expectedRevision: 1, review }),
        /草稿已更新/
      )

      const outcome = {
        status: 'no_op' as const,
        target: { kind: 'video' as const, id: 7 },
        warnings: []
      }
      repo.completeApply({
        draftId: draft.id,
        reviewToken: review.token,
        idempotencyKey: 'apply-1',
        outcome
      })
      assert.deepEqual(repo.getStoredOutcome({ draftId: draft.id, idempotencyKey: 'apply-1' }), outcome)
      assert.equal(repo.getStoredOutcome({ draftId: draft.id, idempotencyKey: 'other' }), null)
      assert.equal(repo.require(draft.id).status, 'applied')
    } finally {
      db.close()
    }
  })

  it('rechecks target existence inside create without mutating existing drafts', () => {
    const { db, repo } = fixture()
    try {
      createVideoDraft(repo, 'draft-7', '.video_scrape_staging/seven/cover-0.jpg')
      createVideoDraft(repo, 'draft-8', '.video_scrape_staging/eight/cover-0.jpg', 8)
      db.prepare('DELETE FROM videos WHERE id = 7').run()

      assert.throws(
        () => createVideoDraft(repo, 'draft-race', '.video_scrape_staging/race/cover-0.jpg'),
        /影片不存在/
      )
      assert.equal(repo.require('draft-7').status, 'ready')
      assert.equal(repo.require('draft-8').status, 'ready')
      assert.deepEqual(
        db
          .prepare(
            `SELECT draft_id, staged_path
             FROM agent_metadata_draft_resources
             ORDER BY draft_id`
          )
          .all(),
        [
          { draft_id: 'draft-7', staged_path: '.video_scrape_staging/seven/cover-0.jpg' },
          { draft_id: 'draft-8', staged_path: '.video_scrape_staging/eight/cover-0.jpg' }
        ]
      )
      assert.equal(repo.get('draft-race'), null)
    } finally {
      db.close()
    }
  })
})
