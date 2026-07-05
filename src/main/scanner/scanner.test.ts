import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { listVideos } from '../db/videoRepo'
import { scanFolders } from './scanner'

let tempRoot: string | null = null

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scan-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  return tempRoot
}

afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('scanFolders', () => {
  it('imports recognized videos and reports unrecognized files', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'IPX-535.mp4'), 'video')
    fs.writeFileSync(path.join(library, 'random_movie.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const progress: Array<{ scanned: number; imported: number; currentFile: string }> = []
    const result = await scanFolders([library], (p) => progress.push(p), { yieldEvery: 1 })

    assert.equal(result.scannedFiles, 2)
    assert.equal(result.imported, 1)
    assert.equal(result.failed, 1)
    assert.deepEqual(result.newCodes, ['IPX-535'])
    assert.equal(result.unrecognizedFiles.length, 1)
    assert.equal(progress.length, 2)

    const videos = listVideos({ limit: 10, offset: 0 })
    assert.equal(videos.total, 1)
    assert.equal(videos.items[0].code, 'IPX-535')
  })

  it('yields while scanning large batches', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    for (let i = 1; i <= 30; i++) {
      fs.writeFileSync(path.join(library, `IPX-${String(i).padStart(3, '0')}.mp4`), 'video')
    }
    initDatabaseAtPath(path.join(root, 'library.db'))

    let scanDone = false
    const scanPromise = scanFolders([library], undefined, { yieldEvery: 1 }).then((result) => {
      scanDone = true
      return result
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scanDone, false)

    const result = await scanPromise
    assert.equal(result.imported, 30)
  })

  it('stops when cancelled', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    for (let i = 1; i <= 30; i++) {
      fs.writeFileSync(path.join(library, `MUKD-${String(i).padStart(3, '0')}.mp4`), 'video')
    }
    initDatabaseAtPath(path.join(root, 'library.db'))

    const controller = new AbortController()
    const result = await scanFolders(
      [library],
      (progress) => {
        if (progress.scanned === 5) controller.abort()
      },
      { signal: controller.signal, yieldEvery: 1 }
    )

    assert.equal(result.cancelled, true)
    assert.equal(result.scannedFiles < 30, true)
  })

  it('skips new imports shorter than 30 minutes', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'IPX-100.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 10 * 60,
      minImportDurationSeconds: 30 * 60
    })

    assert.equal(result.imported, 0)
    assert.equal(result.skippedShort, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unrecognizedFiles.length, 0)
    assert.equal(listVideos({ limit: 10, offset: 0 }).total, 0)
  })

  it('skips short files before unrecognized handling', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, '1f1hurx.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 114,
      minImportDurationSeconds: 30 * 60
    })

    assert.equal(result.imported, 0)
    assert.equal(result.skippedShort, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unrecognizedFiles.length, 0)
  })

  it('stores probed duration on import', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'IPX-535.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })

    const row = getDb()
      .prepare('SELECT file_duration_seconds FROM video_files WHERE file_path = ?')
      .get(filePath) as { file_duration_seconds: number | null }
    assert.equal(row.file_duration_seconds, 3661)
  })

  it('refreshes duration when the file changes on rescan', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'IPX-535.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    let duration = 1000
    const scanOptions = {
      readDurationSeconds: async () => duration,
      minImportDurationSeconds: null
    }

    await scanFolders([library], undefined, { ...scanOptions, yieldEvery: 1 })
    fs.writeFileSync(filePath, 'updated video content')
    duration = 2000
    const result = await scanFolders([library], undefined, { ...scanOptions, yieldEvery: 1 })

    assert.equal(result.imported, 0)
    assert.equal(result.skipped, 1)
    const row = getDb()
      .prepare('SELECT file_duration_seconds FROM video_files WHERE file_path = ?')
      .get(filePath) as { file_duration_seconds: number | null }
    assert.equal(row.file_duration_seconds, 2000)
  })

  it('skips duration probe on rescan when file is unchanged', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'IPX-535.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    let probeCount = 0
    const scanOptions = {
      readDurationSeconds: async () => {
        probeCount += 1
        return 3661
      },
      minImportDurationSeconds: null,
      yieldEvery: 1
    }

    await scanFolders([library], undefined, scanOptions)
    const afterFirst = probeCount
    await scanFolders([library], undefined, scanOptions)

    assert.equal(probeCount, afterFirst)
    const row = getDb()
      .prepare('SELECT file_duration_seconds, file_mtime_ms FROM video_files WHERE file_path = ?')
      .get(filePath) as { file_duration_seconds: number | null; file_mtime_ms: number | null }
    assert.equal(row.file_duration_seconds, 3661)
    assert.notEqual(row.file_mtime_ms, null)
  })
})
