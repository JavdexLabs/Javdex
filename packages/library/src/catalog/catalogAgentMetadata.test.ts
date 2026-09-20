import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { initDatabaseAtPath, closeDatabase } from '../db/database'
import { AGENT_METADATA_SCHEMA_SQL, AGENT_PLATFORM_SCHEMA_SQL } from '../db/schema'
import { AgentMetadataDraftRepo } from '../db/agentMetadataDraftRepo'
import { readVideoAggregateVersion } from './catalogAggregateVersion'
import { applyAgentMetadataDraft, applyAgentMetadataDraftToCatalog } from './catalogAgentMetadata'

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
