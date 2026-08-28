import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentMetadataDraftRepo } from '../../db/agentMetadataDraftRepo'
import { closeDatabase, getDb, initDatabaseAtPath } from '../../db/database'
import type { AgentMetadataBrowserAdapter } from './browserAdapter'
import { AgentMetadataDraftService } from './draftService'

const EVIDENCE_REF = '.javdex/browser/aaaaaaaaaaaaaaaaaaaaaaaa.json'

describe('AgentMetadataDraftService target deletion race', () => {
  beforeEach(() => {
    const db = initDatabaseAtPath(':memory:')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO agent_runs (
         id, use_case, status, config_revision, config_snapshot_json, runtime_id,
         product_state_json, created_at, updated_at
       ) VALUES ('run-race', 'metadata-collector', 'running', 'test', '{}', 'pi', '{}', ?, ?)`
    ).run(now, now)
    db.exec("INSERT INTO videos (id, code) VALUES (7, 'ABC-123'), (8, 'XYZ-008')")
  })

  afterEach(() => closeDatabase())

  it('cleans newly staged files when the video disappears before draft create', async () => {
    const repo = new AgentMetadataDraftRepo(getDb)
    repo.create({
      id: 'other-video-draft',
      runId: 'run-race',
      target: { kind: 'video', id: 8 },
      source: {
        requestedUrl: 'https://example.test/video/XYZ-008',
        displayUrl: 'example.test / video / XYZ-008'
      },
      payload: {
        kind: 'video',
        result: { code: 'XYZ-008', title: 'Other' },
        observedFields: ['title'],
        explicitlyEmptyFields: [],
        evidenceRefs: [EVIDENCE_REF]
      },
      resources: [
        {
          field: 'cover',
          position: 0,
          remoteUrl: 'https://cdn.example.test/other.jpg',
          stagedPath: '.video_scrape_staging/other/cover-0.jpg',
          width: 640,
          height: 480,
          sizeBytes: 12,
          sha256: 'a'.repeat(64)
        }
      ],
      warnings: []
    })

    const cleaned: Array<{ kind: string; paths: string[] }> = []
    const browser = {
      source: () => ({
        requestedUrl: 'https://example.test/video/ABC-123',
        finalUrl: 'https://example.test/video/ABC-123',
        displayUrl: 'example.test / video / ABC-123',
        sourceName: 'example.test'
      }),
      assertEvidenceRefs: () => {}
    } as unknown as AgentMetadataBrowserAdapter
    const service = new AgentMetadataDraftService(repo, browser, {
      stageResources: async () => {
        getDb().prepare('DELETE FROM videos WHERE id = 7').run()
        return [
          {
            field: 'cover',
            position: 0,
            remoteUrl: 'https://cdn.example.test/race.jpg',
            stagedPath: '.video_scrape_staging/race/cover-0.jpg',
            width: 640,
            height: 480,
            sizeBytes: 12,
            sha256: 'b'.repeat(64)
          }
        ]
      },
      cleanupStaging: (kind, paths) => cleaned.push({ kind, paths })
    })

    await assert.rejects(
      service.prepare({
        runId: 'run-race',
        target: { kind: 'video', id: 7 },
        args: {
          kind: 'video',
          observedFields: ['cover'],
          explicitlyEmptyFields: [],
          data: { code: 'ABC-123', coverUrl: 'https://cdn.example.test/race.jpg' },
          evidenceRefs: [EVIDENCE_REF]
        },
        signal: new AbortController().signal
      }),
      /影片不存在/
    )

    assert.deepEqual(cleaned, [
      { kind: 'video', paths: ['.video_scrape_staging/race/cover-0.jpg'] }
    ])
    assert.equal(repo.get('other-video-draft')?.status, 'ready')
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT staged_path FROM agent_metadata_draft_resources
           WHERE draft_id = 'other-video-draft'`
        )
        .all(),
      [{ staged_path: '.video_scrape_staging/other/cover-0.jpg' }]
    )
    assert.equal(repo.findReadyForTarget({ kind: 'video', id: 7 }), null)
  })
})
