// Research probe, not a server entry point or an Electron compatibility shim.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, initDatabaseAtPath, openReadOnlyDatabaseAtPath } from '../../apps/desktop/src/main/db/database'
import { CURRENT_SCHEMA_VERSION } from '../../apps/desktop/src/main/db/migrations'

async function main(): Promise<void> {
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
    node: process.version, modules: process.versions.modules, sharp: sharp.versions.sharp }))
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'x64')
  assert.equal(process.versions.electron, undefined)
  assert.throws(() => require.resolve('electron'), { code: 'MODULE_NOT_FOUND' })

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-probe-'))
  try {
    const databasePath = path.join(directory, 'library.db')
    const writer = initDatabaseAtPath(databasePath)
    assert.equal(writer.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
    assert.equal(writer.pragma('journal_mode', { simple: true }), 'wal')
    writer.prepare('INSERT INTO actresses (main_name) VALUES (?)').run('Docker probe')
    const reader = openReadOnlyDatabaseAtPath(databasePath)
    try {
      assert.equal((reader.prepare('SELECT COUNT(*) AS n FROM actresses').get() as { n: number }).n, 1)
      assert.throws(() => reader.prepare("INSERT INTO actresses (main_name) VALUES ('invalid')").run())
    } finally { reader.close() }
    closeDatabase()
    const reopened = initDatabaseAtPath(databasePath)
    assert.equal((reopened.prepare('SELECT main_name FROM actresses').get() as { main_name: string }).main_name, 'Docker probe')
    assert.deepEqual(reopened.pragma('foreign_key_check'), [])
    assert.deepEqual(reopened.pragma('integrity_check'), [{ integrity_check: 'ok' }])
    console.log(`PASS: real schema ${CURRENT_SCHEMA_VERSION}, WAL reader, read-only enforcement, close/reopen and integrity`)

    const png = await sharp({ create: { width: 32, height: 16, channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer()
    const thumbnail = await sharp(png).resize({ width: 8 }).webp().toBuffer()
    const metadata = await sharp(thumbnail).metadata()
    assert.equal(metadata.width, 8)
    assert.equal(metadata.height, 4)
    const nativeModules = Object.keys(require.cache).filter(filename => filename.endsWith('.node'))
    assert.ok(nativeModules.some(filename => filename.includes('better-sqlite3/prebuilds/linux-x64.node')))
    assert.ok(nativeModules.some(filename => filename.includes('sharp-linux-x64')))
    console.log(JSON.stringify({ nativeModules }))
    console.log('PASS: native sharp PNG generation, WebP thumbnail and decode')

    // Record the real, unmodified module graph failure; never replace Electron with a stub.
    for (const modulePath of ['../../apps/desktop/src/main/web/server', '../../apps/desktop/src/main/web/catalog']) {
      let failure: NodeJS.ErrnoException | undefined
      try { require(modulePath) } catch (error) { failure = error as NodeJS.ErrnoException }
      assert.ok(failure, `${modulePath} unexpectedly loaded; update the research conclusion`)
      assert.equal(failure.code, 'MODULE_NOT_FOUND')
      assert.match(failure.message, /Cannot find module 'electron'/)
      console.log(`CONFIRMED BLOCKER: ${modulePath}\n${failure.message}`)
    }
  } finally {
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
