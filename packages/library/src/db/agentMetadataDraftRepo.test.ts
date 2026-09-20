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
  return { db, repo: new AgentMetadataDraftRepo(() => db) }
}

function createVideoDraft(repo: AgentMetadataDraftRepo, id: string, stagedPath: string) {
  return repo.create({
    id,
    runId: 'run-1',
    target: { kind: 'video', id: 7 },
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

  it('fails closed when a stored draft uses an unsupported adapter version', () => {
    const { db, repo } = fixture()
    try {
      createVideoDraft(repo, 'draft-version', '.video_scrape_staging/one/cover-0.jpg')
      db.prepare('UPDATE agent_metadata_drafts SET adapter_schema_version = 2 WHERE id = ?')
        .run('draft-version')

      assert.throws(() => repo.require('draft-version'), /适配器版本不兼容/)
    } finally {
      db.close()
    }
  })
})

it('reads ready staging references only from the explicitly supplied store and target kind', () => {
  const work = fixture()
  const catalog = fixture()
  try {
    createVideoDraft(catalog.repo, 'catalog-draft', 'catalog/cover.jpg')
    createVideoDraft(work.repo, 'old-draft', 'work/old.jpg')
    const current = createVideoDraft(work.repo, 'current-draft', 'work/current.jpg').draft
    assert.deepEqual(work.repo.listReadyStagedPaths('video'), ['work/current.jpg'])
    assert.deepEqual(work.repo.listReadyStagedPaths('actress'), [])
    assert.deepEqual(catalog.repo.listReadyStagedPaths('video'), ['catalog/cover.jpg'])
    work.repo.discard({ draftId: current.id, expectedRevision: current.revision })
    assert.deepEqual(work.repo.listReadyStagedPaths('video'), [])
  } finally {
    work.db.close()
    catalog.db.close()
  }
})

it('keeps terminal drafts and resource identities in lifecycle snapshots', () => {
  const { db, repo } = fixture()
  try {
    createVideoDraft(repo, 'first', 'work/first.jpg')
    createVideoDraft(repo, 'second', 'work/second.jpg')
    const snapshot = repo.lifecycleSnapshot({ kind: 'video', id: 7 })
    assert.deepEqual(snapshot.drafts.map(({ id, status, revision }) => ({ id, status, revision })), [
      { id: 'first', status: 'discarded', revision: 2 },
      { id: 'second', status: 'ready', revision: 1 }
    ])
    assert.deepEqual(snapshot.staging.map(({ owner_id, staged_path }) => ({ owner_id, staged_path })), [
      { owner_id: 'first', staged_path: 'work/first.jpg' },
      { owner_id: 'second', staged_path: 'work/second.jpg' }
    ])
    assert.ok(snapshot.staging.every(row => Number.isInteger(row.resource_id)))
    assert.deepEqual(repo.lifecycleSnapshot({ kind: 'actress', id: 7 }), { drafts: [], staging: [] })
    assert.deepEqual(repo.lifecycleSnapshot({ kind: 'video', id: 8 }), { drafts: [], staging: [] })
  } finally {
    db.close()
  }
})

it('deletes exactly a lifecycle snapshot and makes completed cleanup replayable', () => {
  const { db, repo } = fixture()
  try {
    createVideoDraft(repo, 'first', 'work/first.jpg')
    const target = { kind: 'video' as const, id: 7 }
    const original = repo.lifecycleSnapshot(target)
    db.prepare('UPDATE agent_metadata_draft_resources SET staged_path=? WHERE draft_id=?').run('work/changed.jpg', 'first')
    assert.throws(() => repo.deleteLifecycleSnapshot(target, original), /草稿已变化/)
    assert.ok(repo.get('first'))
    const current = repo.lifecycleSnapshot(target)
    repo.deleteLifecycleSnapshot(target, current)
    assert.equal(repo.get('first'), null)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_metadata_draft_resources').get() as { n: number }).n, 0)
    repo.deleteLifecycleSnapshot(target, current)
    createVideoDraft(repo, 'new-draft', 'work/new.jpg')
    assert.throws(() => repo.deleteLifecycleSnapshot(target, current), /草稿已变化/)
    assert.ok(repo.get('new-draft'))
  } finally {
    db.close()
  }
})
