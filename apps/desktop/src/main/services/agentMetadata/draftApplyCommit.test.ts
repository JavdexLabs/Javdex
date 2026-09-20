import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { ensureCatalogIdentity } from '@library/catalog/catalogIdentity'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { openDesktopWorkStore, type DesktopWorkStoreHandle } from '../../desktop/workStore'
import { AgentMetadataApplyCommit, type AgentDraftCatalogResult } from './draftApplyCommit'

let root: string | undefined
let work: DesktopWorkStoreHandle | undefined
afterEach(() => {
  work?.close()
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
  work = undefined
})
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-draft-commit-'))
  const catalog = initDatabaseAtPath(path.join(root, 'catalog.db'))
  const identity = ensureCatalogIdentity()
  catalog.exec("INSERT INTO videos(id,code,title) VALUES(7,'ABC-007','before')")
  work = openDesktopWorkStore(path.join(root, 'work.db'))
  const db = work.database()
  db.exec(`INSERT INTO agent_runs(id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
    VALUES('run','metadata-collector','settled','1','{}','pi','{}','before','before')`)
  const repo = new AgentMetadataDraftRepo(() => db)
  const draft = repo.create({ id: 'draft', runId: 'run', target: { kind: 'video', id: 7 },
    source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
    payload: { kind: 'video', result: { title: 'after', code: 'ABC-007' },
      observedFields: ['title'], explicitlyEmptyFields: [], evidenceRefs: ['evidence'] },
    resources: [], warnings: [] }).draft
  repo.saveReview({ draftId: draft.id, expectedRevision: 1, review: {
    kind: 'video', draftId: draft.id, revision: 2, token: 'review',
    selection: { kind: 'video', draftId: draft.id, expectedRevision: 2, fields: ['title'], mode: 'replace' },
    impacts: [], warnings: [], classifications: [], canApply: true
  } })
  const input = { draftId: 'draft', reviewToken: 'review', idempotencyKey: randomUUID() }
  const result: AgentDraftCatalogResult = { outcome: {
    status: 'applied', target: { kind: 'video', id: 7 }, warnings: []
  }, cleanup: { kind: 'video', stagedPaths: ['staging/cover'] } }
  let calls = 0
  const apply = () => {
    calls += 1
    catalog.prepare("UPDATE videos SET title='after', revision=revision+1 WHERE id=7").run()
    return result
  }
  return { catalog, db, repo, identity, input, result, apply, calls: () => calls,
    commit: new AgentMetadataApplyCommit(db, catalog) }
}

it('recovers a catalog commit after work completion fails, including a real work-store reopen', () => {
  const f = fixture()
  f.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON agent_metadata_drafts
    WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'work write failed'); END`)
  assert.throws(() => f.commit.apply(f.input, f.apply, () => { throw new Error('cleanup too early') }), /work write failed/)
  assert.equal(f.repo.require('draft').status, 'ready')
  assert.deepEqual(f.catalog.prepare('SELECT title,revision FROM videos WHERE id=7').get(), { title: 'after', revision: 2 })
  assert.equal(f.calls(), 1)
  const filePath = work!.filePath
  work!.close()
  work = openDesktopWorkStore(filePath)
  work.database().exec('DROP TRIGGER fail_completion')
  const restored = new AgentMetadataApplyCommit(work.database(), f.catalog)
  const cleaned: string[] = []
  assert.equal(restored.recoverCommitted(cleanup => cleaned.push(...cleanup.stagedPaths)), 1)
  assert.deepEqual(cleaned, ['staging/cover'])
  assert.equal(restored.recoverCommitted(() => { throw new Error('cleanup repeated') }), 0)
  assert.equal(new AgentMetadataDraftRepo(() => work!.database()).require('draft').status, 'applied')
  assert.deepEqual(restored.apply(f.input, () => { throw new Error('catalog applied twice') }, () => {}), f.result.outcome)
  assert.equal(f.calls(), 1)
})

it('retains cleanup work after failure and reuses the original operation on retry', () => {
  const f = fixture()
  assert.throws(() => f.commit.apply(f.input, f.apply, () => { throw new Error('cleanup failed') }), /cleanup failed/)
  assert.equal(f.repo.require('draft').status, 'applied')
  const cleaned: string[] = []
  assert.deepEqual(f.commit.apply({ ...f.input, idempotencyKey: randomUUID() },
    () => { throw new Error('catalog applied twice') }, cleanup => cleaned.push(...cleanup.stagedPaths)), f.result.outcome)
  assert.deepEqual(cleaned, ['staging/cover'])
  assert.equal(f.calls(), 1)
})

it('rolls back pre-commit catalog failure without completing the draft or cleaning resources', () => {
  const f = fixture()
  assert.throws(() => f.commit.apply(f.input, () => { f.apply(); throw new Error('before commit') },
    () => { throw new Error('cleanup too early') }), /before commit/)
  assert.deepEqual(f.catalog.prepare('SELECT title,revision FROM videos WHERE id=7').get(), { title: 'before', revision: 1 })
  assert.equal(f.repo.require('draft').status, 'ready')
  assert.equal(f.db.prepare('SELECT 1 FROM agent_metadata_apply_intents').get(), undefined)
})

it('does not resume an unknown operation or finish it against a different catalog', () => {
  const f = fixture()
  const request = { operationId: f.input.idempotencyKey, operation: 'agentMetadata.apply',
    writerEpoch: 0, expectedVersions: {}, input: { draftId: 'draft', reviewToken: 'review', revision: 2, target: { kind: 'video', id: 7 } } }
  f.db.prepare(`INSERT INTO agent_metadata_apply_intents(draft_id,catalog_id,review_token,operation_id,request_json)
    VALUES('draft',?,'review',?,?)`).run(f.identity.catalogId, f.input.idempotencyKey, JSON.stringify(request))
  assert.equal(f.commit.recoverCommitted(() => { throw new Error('unknown cleanup') }), 0)
  assert.equal(f.calls(), 0)
  f.catalog.prepare('UPDATE catalog_identity SET catalog_id=?').run(randomUUID())
  assert.throws(() => f.commit.apply(f.input, f.apply, () => {}), /其它资料库/)
  assert.equal(f.repo.require('draft').status, 'ready')
  assert.equal(f.calls(), 0)
})

it('rejects an edited draft when retrying an intent without a catalog receipt', () => {
  const f = fixture()
  const request = { operationId: f.input.idempotencyKey, operation: 'agentMetadata.apply',
    writerEpoch: f.identity.writerEpoch, expectedVersions: {},
    input: { draftId: 'draft', reviewToken: 'review', revision: 2, target: { kind: 'video', id: 7 } } }
  f.db.prepare(`INSERT INTO agent_metadata_apply_intents(draft_id,catalog_id,review_token,operation_id,request_json)
    VALUES('draft',?,'review',?,?)`).run(f.identity.catalogId, f.input.idempotencyKey, JSON.stringify(request))
  f.db.prepare('UPDATE agent_metadata_drafts SET revision=revision+1 WHERE id=?').run('draft')
  assert.throws(() => f.commit.apply(f.input, f.apply, () => {
    throw new Error('cleanup too early')
  }), /草稿在提交后已变化/)
  assert.equal(f.calls(), 0)
  assert.equal(f.repo.require('draft').status, 'ready')
  assert.deepEqual(f.catalog.prepare('SELECT title,revision FROM videos WHERE id=7').get(), { title: 'before', revision: 1 })
  assert.equal(f.db.prepare('SELECT 1 FROM agent_metadata_apply_intents').get(), undefined)
})

it('resumes cleanup from the receipt before requiring staging and guards unfinished drafts', () => {
  const f = fixture()
  assert.equal(f.commit.resume(f.input, () => {}), null)
  f.commit.assertMutable('draft')
  assert.throws(() => f.commit.apply(f.input, f.apply, () => { throw new Error('cleanup failed') }), /cleanup failed/)
  assert.throws(() => f.commit.assertMutable('draft'), /未核对/)
  assert.throws(() => f.commit.resume({ ...f.input, reviewToken: 'other' }, () => {}), /其它资料库或预览/)
  const cleaned: string[] = []
  assert.deepEqual(f.commit.resume({ ...f.input, idempotencyKey: randomUUID() },
    cleanup => cleaned.push(...cleanup.stagedPaths)), f.result.outcome)
  assert.deepEqual(cleaned, ['staging/cover'])
  assert.equal(f.calls(), 1)
  f.commit.assertMutable('draft')
})

it('releases a locally uncommitted attempt but never releases a proven catalog commit', () => {
  const f = fixture()
  const request = { operationId: f.input.idempotencyKey, operation: 'agentMetadata.apply',
    writerEpoch: f.identity.writerEpoch, expectedVersions: {}, input: {
      draftId: 'draft', reviewToken: 'review', revision: 2, target: { kind: 'video', id: 7 }
    } }
  f.db.prepare(`INSERT INTO agent_metadata_apply_intents(draft_id,catalog_id,review_token,operation_id,request_json)
    VALUES('draft',?,'review',?,?)`).run(f.identity.catalogId, f.input.idempotencyKey, JSON.stringify(request))
  assert.throws(() => f.commit.releaseUncommitted({ ...f.input, reviewToken: 'other' }), /身份不一致/)
  assert.throws(() => f.commit.assertMutable('draft'), /未核对/)
  f.commit.releaseUncommitted(f.input)
  f.commit.assertMutable('draft')
  assert.throws(() => f.commit.apply(f.input, f.apply, () => { throw new Error('cleanup failed') }), /cleanup failed/)
  assert.throws(() => f.commit.releaseUncommitted(f.input), /已提交/)
  assert.throws(() => f.commit.assertMutable('draft'), /未核对/)
  assert.deepEqual(f.commit.resume(f.input, () => {}), f.result.outcome)
  assert.equal(f.calls(), 1)
})

it('retries discard cleanup and releases a rejected catalog discard without changing work state', async () => {
  const { AgentMetadataDiscardCommit } = await import('./draftDiscardCommit')
  const f = fixture()
  const discard = new AgentMetadataDiscardCommit(f.db, f.catalog, f.commit)
  const request = { operationId: randomUUID(), operation: 'agentMetadata.discard',
    writerEpoch: 0, expectedVersions: { Q: { generation: 1, revision: 2 } }, input: { draftId: 'draft' } }
  f.catalog.exec('UPDATE catalog_identity SET frozen=1')
  assert.throws(() => discard.discard('draft', request, () => { throw new Error('cleanup too early') }))
  assert.equal(f.repo.require('draft').status, 'ready')
  assert.equal(f.db.prepare('SELECT 1 FROM agent_metadata_discard_intents').get(), undefined)
  f.catalog.exec('UPDATE catalog_identity SET frozen=0')
  assert.throws(() => discard.discard('draft', request, () => { throw new Error('cleanup failed') }), /cleanup failed/)
  assert.equal(f.repo.require('draft').status, 'discarded')
  assert.throws(() => f.commit.assertMutable('draft'), /未核对/)
  const cleaned: string[] = []
  assert.deepEqual(discard.discard('draft', request, (_kind, paths) => cleaned.push(...paths)), { ok: true })
  assert.equal(f.repo.require('draft').revision, 3)
  discard.recoverCommitted(() => { throw new Error('cleanup repeated') })
  assert.equal((f.db.prepare('SELECT cleaned FROM agent_metadata_discard_intents').get() as { cleaned: number }).cleaned, 1)
})

it('releases a discard interrupted before catalog commit after reopening the work store', async () => {
  const { AgentMetadataDiscardCommit } = await import('./draftDiscardCommit')
  const f = fixture()
  const request = { operationId: randomUUID(), operation: 'agentMetadata.discard',
    writerEpoch: 0, expectedVersions: { Q: { generation: 1, revision: 2 } }, input: { draftId: 'draft' } }
  f.db.prepare(`INSERT INTO agent_metadata_discard_intents
    (draft_id,catalog_id,operation_id,request_json,revision,kind,staged_paths_json)
    VALUES('draft',?,?,?,2,'video','[]')`)
    .run(f.identity.catalogId, request.operationId, JSON.stringify(request))
  const workPath = work!.filePath
  work!.close()
  work = openDesktopWorkStore(workPath)
  const db = work.database()
  const applications = new AgentMetadataApplyCommit(db, f.catalog)
  const discard = new AgentMetadataDiscardCommit(db, f.catalog, applications)
  assert.throws(() => applications.assertMutable('draft'), /未核对/)
  discard.recoverCommitted(() => { throw new Error('uncommitted discard must not clean resources') })
  applications.assertMutable('draft')
  const repo = new AgentMetadataDraftRepo(() => db)
  assert.equal(repo.require('draft').status, 'ready')
  assert.equal(repo.require('draft').revision, 2)
  assert.deepEqual(discard.discard('draft', { ...request, operationId: randomUUID() }, () => {}), { ok: true })
  assert.equal(repo.require('draft').status, 'discarded')
  discard.recoverCommitted(() => { throw new Error('cleanup repeated') })
})
