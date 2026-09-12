import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebServer } from '../packages/http/src/server.ts'
import { WebCatalog } from '../packages/http/src/catalog.ts'
import { WebCatalogQueryReader } from '../packages/http/src/catalogQueryReader.ts'
import { createManageHttpServer } from '../packages/http/src/surfaces.ts'
import { initDatabaseAtPath, closeDatabase } from '../packages/library/src/db/database.ts'

assert.equal(process.versions.electron, undefined, 'http node-load must not run under Electron')
assert.equal(WebServer.name, 'WebServer')
assert.equal(WebCatalog.name, 'WebCatalog')
assert.equal(WebCatalogQueryReader.name, 'WebCatalogQueryReader')
assert.throws(() => createManageHttpServer(), /管理 HTTP 面不能由浏览服务装配/)

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-http-node-load-'))
try {
  const db = initDatabaseAtPath(path.join(directory, 'library.db'))
  const reader = new WebCatalogQueryReader(db)
  const collections = reader.collections()
  assert.equal(Array.isArray(collections.libraries), true)
  assert.equal(Array.isArray(collections.playlists), true)
} finally {
  closeDatabase()
  fs.rmSync(directory, { recursive: true, force: true })
}

console.log('HTTP and catalog query reader loaded under plain Node without Electron.')
