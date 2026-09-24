import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { initDatabaseAtPath, closeDatabase } from '../db/database'
import { AGENT_METADATA_SCHEMA_SQL, AGENT_PLATFORM_SCHEMA_SQL } from '../db/schema'
import { AgentMetadataDraftRepo } from '../db/agentMetadataDraftRepo'
import { readVideoAggregateVersion } from './catalogAggregateVersion'
import {
  applyAgentMetadataDraft,
  applyAgentMetadataDraftToCatalog,
  applyTransferredAgentMetadataCandidate
} from './catalogAgentMetadata'
import { buildAgentMetadataReview } from './catalogAgentMetadataReview'
import { ensureCatalogIdentity } from './catalogIdentity'
import { completeCatalogUploadFromBuffer, createCatalogUpload, readCatalogUpload } from './catalogUploads'
import { commitManageImageMutation } from './catalogImageApply'
import { mediaAssetStore } from '../mediaAssetStore'
import type { AgentMetadataCandidateTransfer } from '@shared/agentMetadataTypes'

for (const separate of [false, true]) {
  it(`applies management metadata with ${separate ? 'explicit work' : 'same catalog'} draft ownership`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-management-draft-'))
    const catalog = initDatabaseAtPath(path.join(root, 'catalog.db'))
    const work = separate ? new Database(':memory:') : catalog
    try {
      if (separate) work.exec(AGENT_PLATFORM_SCHEMA_SQL + AGENT_METADATA_SCHEMA_SQL)
      catalog.exec("INSERT INTO videos(id,code,title) VALUES(7,'ABC-007','before')")
      work.exec(`INSERT INTO agent_runs(id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
        VALUES('run','metadata-collector','settled','1','{}','pi','{}','before','before')`)
      const repo = new AgentMetadataDraftRepo(() => work)
      repo.create({ id: 'draft', runId: 'run', target: { kind: 'video', id: 7 },
        source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
        payload: { kind: 'video', result: { code: 'ABC-007', title: 'after' },
          observedFields: ['title'], explicitlyEmptyFields: [], evidenceRefs: [] }, resources: [], warnings: [] })
      repo.saveReview({ draftId: 'draft', expectedRevision: 1, review: {
        kind: 'video', draftId: 'draft', revision: 2, token: 'review',
        selection: { kind: 'video', draftId: 'draft', expectedRevision: 2, fields: ['title'], mode: 'replace' },
        impacts: [], warnings: [], classifications: [], canApply: true
      } })
      const input = { draftId: 'draft', reviewToken: 'review', operationId: randomUUID(), database: catalog,
        expected: { V: readVideoAggregateVersion(7, catalog)!, Q: { generation: 1, revision: 2 } } }
      assert.throws(() => applyAgentMetadataDraftToCatalog({ ...input, expected: { ...input.expected, Q: { generation: 1, revision: 1 } } }, repo))
      assert.equal((catalog.prepare('SELECT title FROM videos WHERE id=7').get() as { title: string }).title, 'before')
      const result = catalog.transaction(() => separate
        ? applyAgentMetadataDraftToCatalog(input, repo)
        : applyAgentMetadataDraft(input))()
      assert.equal(result.status, 'applied')
      assert.equal((catalog.prepare('SELECT title FROM videos WHERE id=7').get() as { title: string }).title, 'after')
      assert.equal(repo.require('draft').status, separate ? 'ready' : 'applied')
      if (separate) assert.equal(catalog.prepare('SELECT 1 FROM agent_metadata_drafts').get(), undefined)
      else assert.deepEqual(applyAgentMetadataDraft(input), result)
    } finally {
      if (separate) work.close()
      closeDatabase()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

it('previews and applies a desktop-owned candidate without a server draft', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-transferred-draft-'))
  const catalog = initDatabaseAtPath(path.join(root, 'catalog.db'))
  try {
    catalog.exec("INSERT INTO videos(id,code,title) VALUES(11,'ABC-011','before')")
    const candidate: AgentMetadataCandidateTransfer = {
      draftId: 'desktop-draft',
      target: { kind: 'video', id: 11 },
      revision: 2,
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: {
        kind: 'video',
        result: { code: 'ABC-011', title: 'after' },
        observedFields: ['title'],
        explicitlyEmptyFields: [],
        evidenceRefs: []
      },
      resources: [],
      warnings: []
    }
    const selection = {
      kind: 'video' as const,
      draftId: candidate.draftId,
      expectedRevision: candidate.revision,
      fields: ['title' as const],
      mode: 'replace' as const
    }
    const review = buildAgentMetadataReview(candidate, selection, candidate.revision, { includeVersions: true })
    const outcome = applyTransferredAgentMetadataCandidate({
      transfer: { candidate, review, uploads: [] },
      reviewToken: review.token,
      expected: { V: readVideoAggregateVersion(11, catalog)! },
      operationId: randomUUID(),
      database: catalog
    })
    assert.equal(outcome.status, 'applied')
    assert.equal((catalog.prepare('SELECT title FROM videos WHERE id=11').get() as { title: string }).title, 'after')
    assert.equal(catalog.prepare('SELECT 1 FROM agent_metadata_drafts').get(), undefined)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('applies a transferred cover once and replays the same operation after a lost response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-transferred-image-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  const catalog = initDatabaseAtPath(path.join(root, 'catalog.db'))
  try {
    const identity = ensureCatalogIdentity({ catalogId: randomUUID() })
    catalog.exec("INSERT INTO videos(id,code,title) VALUES(12,'ABC-012','before')")
    const body = await sharp({ create: { width: 16, height: 10, channels: 3,
      background: { r: 80, g: 20, b: 20 } } }).png().toBuffer()
    const sha256 = createHash('sha256').update(body).digest('hex')
    const first: AgentMetadataCandidateTransfer = {
      draftId: 'desktop-cover', target: { kind: 'video', id: 12 }, revision: 1,
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: { kind: 'video', result: { code: 'ABC-012', coverUrl: 'https://example.test/cover.png' },
        observedFields: ['cover'], explicitlyEmptyFields: [], evidenceRefs: [] },
      resources: [{ field: 'cover', position: 0, remoteUrl: 'https://example.test/cover.png',
        width: 16, height: 10, sizeBytes: body.byteLength, sha256 }], warnings: []
    }
    const selection = { kind: 'video' as const, draftId: first.draftId, expectedRevision: 1,
      fields: ['cover' as const], mode: 'replace' as const }
    const initial = buildAgentMetadataReview(first, selection, 2, { includeVersions: true })
    const candidate = { ...first, revision: 2 }
    const review = buildAgentMetadataReview(candidate,
      { ...selection, expectedRevision: 2 }, 2, { includeVersions: true })
    assert.equal(review.token, initial.token)
    const upload = createCatalogUpload({ purpose: 'videoCover', contentType: 'image/png',
      writerEpoch: identity.writerEpoch, catalogId: identity.catalogId })
    await completeCatalogUploadFromBuffer(upload.uploadId, body, {
      writerEpoch: identity.writerEpoch, catalogId: identity.catalogId, contentType: 'image/png'
    })
    const transfer = { candidate, review: { kind: review.kind, draftId: review.draftId,
      revision: review.revision, token: review.token, selection: review.selection,
      previewVersions: review.previewVersions }, uploads: [{ field: 'cover' as const, position: 0,
      image: { kind: 'upload' as const, uploadId: upload.uploadId } }] }
    const operationId = randomUUID()
    const request = { operationId, operation: 'agentMetadata.apply' as const,
      expectedVersions: review.previewVersions!, input: { draftId: candidate.draftId,
        reviewToken: review.token, transfer }, writerEpoch: identity.writerEpoch }
    const apply = () => commitManageImageMutation(request, () => applyTransferredAgentMetadataCandidate({
      transfer, reviewToken: review.token, expected: review.previewVersions!, operationId,
      database: catalog
    }), catalog)
    const firstResult = apply()
    assert.equal(firstResult.outcome, 'applied')
    assert.equal(firstResult.data.status, 'applied')
    const coverPath = (catalog.prepare('SELECT cover_path FROM videos WHERE id=12').get() as { cover_path: string }).cover_path
    assert.equal(fs.existsSync(mediaAssetStore.resolve(coverPath)), true)
    assert.equal(readCatalogUpload(upload.uploadId)?.status, 'consumed')
    const retry = apply()
    assert.equal(retry.outcome, 'duplicate')
    assert.equal((catalog.prepare('SELECT cover_path FROM videos WHERE id=12').get() as { cover_path: string }).cover_path, coverPath)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
    delete process.env.JAVDEX_TEST_USER_DATA
  }
})
