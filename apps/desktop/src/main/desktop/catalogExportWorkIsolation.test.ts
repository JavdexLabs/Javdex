import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateDatabase } from '@library/db/migrations'
import { stripExportSecrets } from '@library/catalog/catalogMigrationApply'
import { listFormallyReferencedImagePaths } from '@library/catalog/catalogImageRefs'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { configureAgentWorkTablePrefix } from '@library/runtime/host'
import { attachAgentWorkStore } from './agentWorkCopy'
import { openDesktopWorkStore } from './workStore'

it('strips only the isolated catalog export while preserving source and live work records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-export-work-isolation-'))
  const catalog = new Database(path.join(root, 'catalog.db'))
  const work = openDesktopWorkStore(path.join(root, 'work.db'))
  let exported: Database.Database | undefined
  const insertRun = (db: Database.Database, id: string) => db.prepare(`INSERT INTO agent_runs
    (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
    VALUES(?,'metadata-collector','settled','1','{}','pi','{}','before','before')`).run(id)
  try {
    migrateDatabase(catalog)
    insertRun(catalog, 'old-source-run')
    insertRun(work.database(), 'active-work-run')
    const addDraft = (db: Database.Database, runId: string, stagedPath: string) => new AgentMetadataDraftRepo(() => db).create({
      id: runId, runId, target: { kind: 'video', id: 7 },
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: { kind: 'video', result: { code: 'ABC-007' }, observedFields: [], explicitlyEmptyFields: [], evidenceRefs: [] },
      resources: [{ field: 'cover', position: 0, remoteUrl: null, stagedPath,
        width: 1, height: 1, sizeBytes: 1, sha256: 'a'.repeat(64) }], warnings: []
    })
    addDraft(catalog, 'old-source-run', 'catalog-staging/cover.jpg')
    addDraft(work.database(), 'active-work-run', 'work-staging/cover.jpg')
    catalog.exec("INSERT INTO videos(id,code,title) VALUES(7,'ABC-007','preserved')")
    attachAgentWorkStore(catalog, work.filePath)
    const catalogImages = listFormallyReferencedImagePaths(catalog)
    assert.equal(catalogImages.has('catalog-staging/cover.jpg'), true)
    assert.equal(catalogImages.has('work-staging/cover.jpg'), false)
    const destination = path.join(root, 'export.db')
    await catalog.backup(destination)
    exported = new Database(destination)
    stripExportSecrets(exported)
    assert.equal((exported.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n, 0)
    assert.deepEqual(exported.prepare('SELECT title FROM videos WHERE id=7').get(), { title: 'preserved' })
    assert.deepEqual(work.database().prepare('SELECT id FROM agent_runs').all(), [{ id: 'active-work-run' }])
    // Read the source through an independent connection, never the legacy SQL router.
    const original = new Database(catalog.name, { readonly: true })
    try {
      assert.deepEqual(original.prepare('SELECT id FROM agent_runs').all(), [{ id: 'old-source-run' }])
    } finally {
      original.close()
    }
  } finally {
    configureAgentWorkTablePrefix('')
    exported?.close()
    catalog.close()
    work.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
