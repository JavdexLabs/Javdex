import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIsolatedCatalog, statusCatalogMigration } from './catalogMigration'
import { catalogLooksEmpty, MIGRATION_FINAL_PREFIX, MIGRATION_STATE_KEY } from './catalogMigrationState'
import { writeCatalogSetting } from './catalogSettings'

let directory: string | undefined
let database: ReturnType<typeof openIsolatedCatalog> | undefined
afterEach(() => {
  database?.close()
  database = undefined
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function setup() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-offline-state-'))
  database = openIsolatedCatalog(path.join(directory, 'library.db'))
  return database
}

for (const [table, column] of [
  ['playlists', 'name'], ['tags', 'name'], ['organizations', 'main_name'],
  ['directors', 'main_name'], ['series', 'main_name']
]) {
  test(`a catalog containing only ${table} is not an empty import target`, () => {
    const db = setup()
    assert.equal(catalogLooksEmpty(db), true)
    db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`).run('Preserve me')
    assert.equal(catalogLooksEmpty(db), false)
  })
}

test('legacy source permission is projected as a local frozen source, never a peer status', () => {
  const db = setup()
  writeCatalogSetting(MIGRATION_STATE_KEY, {
    migrationId: 'source', role: 'source', sourcePhase: 'enableAuthorized',
    targetPhase: 'prepare', digest: 'digest', allowEnableAt: 'yesterday'
  }, db)
  assert.deepEqual(statusCatalogMigration({ migrationId: 'source' }, db), {
    migrationId: 'source', role: 'source', phase: 'frozen', digest: 'digest'
  })
  writeCatalogSetting(`${MIGRATION_FINAL_PREFIX}target`, {
    migrationId: 'target', role: 'target', sourcePhase: 'frozen',
    targetPhase: 'enabled', digest: 'digest'
  }, db)
  assert.deepEqual(statusCatalogMigration({ migrationId: 'target' }, db), {
    migrationId: 'target', role: 'target', phase: 'enabled', digest: 'digest'
  })
})
