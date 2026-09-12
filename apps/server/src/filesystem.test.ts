import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { acquireDataDirLock, ensureLocalDataDir, ensureMediaMounts } from './filesystem'

describe('server filesystem checks', () => {
  it('locks a data directory to a single process and separates media mounts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-fs-'))
    const dataDir = path.join(root, 'data')
    const imagesDir = path.join(dataDir, 'media_assets')
    const media = path.join(root, 'media')
    try {
      ensureLocalDataDir(dataDir)
      fs.mkdirSync(media)
      const mounts = ensureMediaMounts(dataDir, imagesDir, { library: media })
      assert.equal(mounts.length, 1)
      const lock = acquireDataDirLock(dataDir)
      assert.throws(() => acquireDataDirLock(dataDir), /占用/)
      lock.release()
      const again = acquireDataDirLock(dataDir)
      again.release()
      assert.throws(
        () => ensureMediaMounts(dataDir, imagesDir, { nested: dataDir }),
        /分离/
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
