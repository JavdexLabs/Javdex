import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { synchronizeActressNameOwnership } from '@library/db/actressNameOwnership'
import { ACTRESS_NAME_TYPE, upsertActressName } from '@library/db/actressNames'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { mediaAssetStore } from '../mediaAssetStore'
import { classificationMaintenanceService } from '../classificationMaintenanceService'
import { AgentMetadataBrowserAdapter } from './browserAdapter'
import { AgentMetadataDraftService } from './draftService'

const JPEG_1X1 = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f00000105010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let root: string | null = null

function setup(): AgentMetadataDraftRepo {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-agent-metadata-draft-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  initDatabaseAtPath(path.join(root, 'javdex.db'))
  const db = getDb()
  db.prepare('INSERT INTO videos (id, code, title) VALUES (7, ?, ?)').run('ABC-123', '')
  db.prepare(
    `INSERT INTO agent_runs (
       id, use_case, status, config_revision, config_snapshot_json, runtime_id,
       product_state_json, created_at, updated_at
     ) VALUES (?, 'metadata-collector', 'settled', 'test', '{}', 'pi', '{}', ?, ?)`
  ).run('run-1', new Date().toISOString(), new Date().toISOString())
  return new AgentMetadataDraftRepo()
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('AgentMetadataDraftService', () => {
  it('rejects a preview when a staged resource no longer matches its manifest', () => {
    const repo = setup()
    const [resource] = mediaAssetStore.stageVideoScrapeImages([{
      field: 'cover',
      position: 0,
      remoteUrl: 'https://cdn.example.test/cover.jpg',
      data: JPEG_1X1
    }])
    assert.ok(resource)
    const draft = repo.create({
      id: 'draft-1',
      runId: 'run-1',
      target: { kind: 'video', id: 7 },
      source: {
        requestedUrl: 'https://example.test/video/ABC-123',
        displayUrl: 'https://example.test/video/ABC-123'
      },
      payload: {
        kind: 'video',
        result: { code: 'ABC-123', title: 'Candidate', coverUrl: resource.remoteUrl },
        observedFields: ['title'],
        explicitlyEmptyFields: [],
        evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
      },
      resources: [{
        ...resource,
        sha256: createHash('sha256').update(JPEG_1X1).digest('hex')
      }],
      warnings: []
    }).draft
    fs.appendFileSync(mediaAssetStore.resolve(resource.stagedPath), Buffer.from([0]))

    const service = new AgentMetadataDraftService(repo)
    assert.throws(() => service.plan({
      kind: 'video',
      draftId: draft.id,
      expectedRevision: draft.revision,
      fields: ['title'],
      mode: 'fillEmpty'
    }), /暂存图片已发生变化/)
  })

  it('rechecks staged resource bytes when applying an already reviewed draft', () => {
    const repo = setup()
    const [resource] = mediaAssetStore.stageVideoScrapeImages([{
      field: 'cover',
      position: 0,
      remoteUrl: 'https://cdn.example.test/cover.jpg',
      data: JPEG_1X1
    }])
    assert.ok(resource)
    const draft = repo.create({
      id: 'draft-apply-integrity',
      runId: 'run-1',
      target: { kind: 'video', id: 7 },
      source: {
        requestedUrl: 'https://example.test/video/ABC-123',
        displayUrl: 'https://example.test/video/ABC-123'
      },
      payload: {
        kind: 'video',
        result: { code: 'ABC-123', title: 'Candidate', coverUrl: resource.remoteUrl },
        observedFields: ['title'],
        explicitlyEmptyFields: [],
        evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
      },
      resources: [{
        ...resource,
        sha256: createHash('sha256').update(JPEG_1X1).digest('hex')
      }],
      warnings: []
    }).draft
    const service = new AgentMetadataDraftService(repo)
    const review = service.plan({
      kind: 'video',
      draftId: draft.id,
      expectedRevision: draft.revision,
      fields: ['title'],
      mode: 'fillEmpty'
    })
    fs.appendFileSync(mediaAssetStore.resolve(resource.stagedPath), Buffer.from([0]))

    assert.throws(() => service.apply({
      draftId: draft.id,
      reviewToken: review.token,
      idempotencyKey: 'apply-integrity-1'
    }), /暂存图片已发生变化/)
  })

  it('cleans newly staged resources when persistence fails', async () => {
    setup()
    const repo = {
      create: () => { throw new Error('database failed') }
    } as unknown as AgentMetadataDraftRepo
    const browser = {
      source: () => ({
        requestedUrl: 'https://example.test/video/ABC-123',
        displayUrl: 'https://example.test/video/ABC-123'
      }),
      assertEvidenceRefs: () => {},
      fetchBuffer: async () => JPEG_1X1
    } as unknown as AgentMetadataBrowserAdapter
    const service = new AgentMetadataDraftService(repo, browser)

    await assert.rejects(service.prepare({
      runId: 'run-1',
      target: { kind: 'video', id: 7 },
      args: {
        kind: 'video',
        observedFields: ['cover'],
        explicitlyEmptyFields: [],
        data: { code: 'ABC-123', coverUrl: 'https://cdn.example.test/cover.jpg' },
        evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
      },
      signal: new AbortController().signal
    }), /database failed/)

    const stagingRoot = path.join(mediaAssetStore.rootPath(), '.video_scrape_staging')
    assert.deepEqual(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [], [])
  })

  it('routes actress name ownership conflicts to the existing pending workflow', () => {
    const repo = setup()
    const db = getDb()
    db.prepare('INSERT INTO actresses (id, main_name) VALUES (1, ?), (2, ?)')
      .run('Alpha', 'Beta')
    upsertActressName(1, 'Alpha', ACTRESS_NAME_TYPE.MAIN, null, null, 1)
    upsertActressName(2, 'Beta', ACTRESS_NAME_TYPE.MAIN, null, null, 1)
    upsertActressName(2, 'Shared Name', ACTRESS_NAME_TYPE.ALIAS, null, null, 0)
    synchronizeActressNameOwnership(1)
    synchronizeActressNameOwnership(2)
    const draft = repo.create({
      id: 'actress-draft-1',
      runId: 'run-1',
      target: { kind: 'actress', id: 1 },
      source: {
        requestedUrl: 'https://example.test/actress/alpha',
        displayUrl: 'https://example.test/actress/alpha',
        sourceName: 'example.test'
      },
      payload: {
        kind: 'actress',
        result: { mainName: 'Alpha', aliases: ['Shared Name'] },
        observedFields: ['aliases'],
        explicitlyEmptyFields: [],
        identityMatched: true,
        evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
      },
      resources: [],
      warnings: []
    }).draft
    const service = new AgentMetadataDraftService(repo)
    const review = service.plan({
      kind: 'actress',
      draftId: draft.id,
      expectedRevision: draft.revision,
      fields: ['aliases'],
      mode: 'replaceIfPresent'
    })
    assert.deepEqual(review.kind === 'actress' ? review.nameConflicts : [], ['Shared Name'])
    assert.equal(review.canApply, true)

    const outcome = service.apply({
      draftId: draft.id,
      reviewToken: review.token,
      idempotencyKey: 'apply-route-1'
    })
    assert.equal(outcome.status, 'routed_to_pending')
    assert.equal(repo.require(draft.id).status, 'routed_to_pending')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS total FROM pending_actress_scrapes').get() as { total: number }).total,
      1
    )
  })

  it('routes duplicate video business identities to the existing pending workflow', () => {
    const repo = setup()
    const db = getDb()
    const [resource] = mediaAssetStore.stageVideoScrapeImages([{
      field: 'cover',
      position: 0,
      remoteUrl: 'https://cdn.example.test/cover.jpg',
      data: JPEG_1X1
    }])
    assert.ok(resource)
    const publisherId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Example Publisher'
    })
    db.prepare(
      `INSERT INTO videos (id, code, publisher_organization_id, release_date)
       VALUES (8, 'ABC-123', ?, '2024-01-02')`
    ).run(publisherId)
    const draft = repo.create({
      id: 'video-draft-conflict',
      runId: 'run-1',
      target: { kind: 'video', id: 7 },
      source: {
        requestedUrl: 'https://example.test/video/ABC-123',
        displayUrl: 'https://example.test/video/ABC-123',
        sourceName: 'example.test'
      },
      payload: {
        kind: 'video',
        result: {
          code: 'ABC-123',
          publisher: 'Example Publisher',
          releaseDate: '2024-01-02',
          coverUrl: resource.remoteUrl
        },
        observedFields: ['publisher', 'releaseDate', 'cover'],
        explicitlyEmptyFields: [],
        evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
      },
      resources: [{
        ...resource,
        sha256: createHash('sha256').update(JPEG_1X1).digest('hex')
      }],
      warnings: []
    }).draft
    const service = new AgentMetadataDraftService(repo)
    const review = service.plan({
      kind: 'video',
      draftId: draft.id,
      expectedRevision: draft.revision,
      fields: ['publisher', 'releaseDate'],
      mode: 'replaceIfPresent'
    })
    assert.equal(review.kind === 'video' ? review.identityConflictVideoId : undefined, 8)
    assert.equal(review.canApply, true)

    const outcome = service.apply({
      draftId: draft.id,
      reviewToken: review.token,
      idempotencyKey: 'apply-video-route-1'
    })
    assert.equal(outcome.status, 'routed_to_pending')
    assert.equal(repo.require(draft.id).status, 'routed_to_pending')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS total FROM pending_video_scrapes').get() as { total: number }).total,
      1
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS total FROM pending_video_scrape_resources').get() as { total: number }).total,
      1
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(resource.stagedPath)), true)
  })

  it('requires explicit user confirmation when actress names do not match', async () => {
    const repo = setup()
    getDb().prepare('INSERT INTO actresses (id, main_name) VALUES (1, ?)').run('Alpha')
    upsertActressName(1, 'Alpha', ACTRESS_NAME_TYPE.MAIN, null, null, 1)
    synchronizeActressNameOwnership(1)
    const browser = {
      source: () => ({
        requestedUrl: 'https://example.test/actress/other',
        displayUrl: 'https://example.test/actress/other'
      }),
      assertEvidenceRefs: () => {},
      fetchBuffer: async () => JPEG_1X1
    } as unknown as AgentMetadataBrowserAdapter
    const service = new AgentMetadataDraftService(repo, browser)
    await service.prepare({
      runId: 'run-1',
      target: { kind: 'actress', id: 1 },
      args: {
        kind: 'actress',
        observedFields: ['profileSummary'],
        explicitlyEmptyFields: [],
        identityMatched: false,
        data: { mainName: 'Other Name', profileSummary: 'Observed profile' },
        evidenceRefs: ['.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json']
      },
      signal: new AbortController().signal
    })
    const draft = service.findReadyForTarget({ kind: 'actress', id: 1 })
    assert.ok(draft)
    const unconfirmed = service.plan({
      kind: 'actress',
      draftId: draft.id,
      expectedRevision: draft.revision,
      fields: ['profileSummary'],
      mode: 'fillEmpty'
    })
    if (unconfirmed.kind !== 'actress') throw new Error('expected actress review')
    assert.equal(unconfirmed.requiresIdentityConfirmation, true)
    assert.equal(unconfirmed.canApply, false)

    const confirmed = service.plan({
      kind: 'actress',
      draftId: draft.id,
      expectedRevision: unconfirmed.revision,
      fields: ['profileSummary'],
      mode: 'fillEmpty',
      identityConfirmed: true
    })
    if (confirmed.kind !== 'actress') throw new Error('expected actress review')
    assert.equal(confirmed.canApply, true)
  })
})
