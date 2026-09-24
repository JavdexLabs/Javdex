import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { ensureCatalogIdentity } from './catalogIdentity'
import { commitCatalogMutation, readOperationReceipt } from './catalogOperations'

let root: string | null = null

function setup(): { videoId: number; title: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-m05-commit-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  initDatabaseAtPath(path.join(root, 'library.db'))
  ensureCatalogIdentity({ catalogId: randomUUID() })
  const videoId = Number(
    getDb().prepare("INSERT INTO videos (code, title) VALUES ('M05-KILL', 'original')").run().lastInsertRowid
  )
  return { videoId, title: 'original' }
}

function reopen(): void {
  closeDatabase()
  initDatabaseAtPath(path.join(root!, 'library.db'))
}

async function waitForPath(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`missing ${filePath}`)
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
  delete process.env.JAVDEX_TEST_STALL_BEFORE_COMMIT
})

it('rolls back a short videos.edit when SIGKILL lands before the SQLite commit', async () => {
  const { videoId, title } = setup()
  const instruction = path.join(root!, 'stall-before-commit')
  const operationId = randomUUID()
  fs.writeFileSync(instruction, '1')
  closeDatabase()
  const child = spawn(
    process.execPath,
    [
      '--require',
      path.resolve('scripts/register-test-paths.cjs'),
      '--import',
      'tsx',
      '--import',
      pathToFileURL(path.resolve('scripts/register-library-test-host.ts')).href,
      path.resolve('packages/library/src/catalog/catalogMutationCrashChild.ts')
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        JAVDEX_MUTATION_CRASH_CHILD: '1',
        JAVDEX_TEST_USER_DATA: root!,
        JAVDEX_TEST_STALL_BEFORE_COMMIT: instruction,
        JAVDEX_CRASH_VIDEO_ID: String(videoId),
        JAVDEX_CRASH_TITLE: 'should-rollback',
        JAVDEX_CRASH_OPERATION_ID: operationId
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const stderr: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'))
  })
  await waitForPath(`${instruction}.ready`)
  assert.equal(child.killed, false)
  child.kill('SIGKILL')
  const status = await new Promise<number | null>((resolve) => {
    child.once('exit', (code, signal) => resolve(signal === 'SIGKILL' ? 137 : code))
  })
  assert.equal(status === 137 || child.signalCode === 'SIGKILL', true, stderr.join(''))
  reopen()
  const row = getDb().prepare('SELECT title, revision FROM videos WHERE id = ?').get(videoId) as {
    title: string
    revision: number
  }
  assert.equal(row.title, title)
  assert.equal(row.revision, 1)
  assert.equal(readOperationReceipt(operationId), null)

  const retryId = randomUUID()
  commitCatalogMutation(
    {
      operationId: retryId,
      operation: 'videos.edit',
      expectedVersions: { V: { generation: 1, revision: 1 } },
      input: { videoId, fields: { title: 'after-kill' } },
      writerEpoch: 0
    },
    () => {
      getDb()
        .prepare('UPDATE videos SET title = ?, revision = revision + 1 WHERE id = ?')
        .run('after-kill', videoId)
      return {
        ok: true,
        videoId,
        versions: { V: { generation: 1, revision: 2 } }
      }
    }
  )
  const applied = getDb().prepare('SELECT title, revision FROM videos WHERE id = ?').get(videoId) as {
    title: string
    revision: number
  }
  assert.equal(applied.title, 'after-kill')
  assert.equal(applied.revision, 2)
  assert.equal(readOperationReceipt(retryId)?.status, 'applied')
})
