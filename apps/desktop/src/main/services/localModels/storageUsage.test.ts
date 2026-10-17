import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { localAiDirectories } from './modelStorage'
import { measureFiles, measureLocalStorage } from './storageUsage'

test('storage counts actual file sizes, classifies VAD as runtime and ignores links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-storage-usage-'))
  const locations = localAiDirectories(root)
  try {
    for (const [directory, size] of [[path.join(locations.store, 'models', 'weights'), 11], [path.join(locations.store, 'models', 'vad'), 7],
      [path.join(locations.store, 'runtimes'), 13], [path.join(locations.store, 'downloads'), 3], [locations.cache, 5], [locations.work, 2], [path.join(root, 'outside'), 99]] as const) {
      await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'file'), Buffer.alloc(size))
    }
    await fs.symlink(path.join(root, 'outside'), path.join(locations.store, 'models', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const usage = await measureLocalStorage(locations.store, locations, ['vad'])
    assert.deepEqual(usage.models, { bytes: 11, files: 1 })
    assert.deepEqual(usage.runtimes, { bytes: 20, files: 2 })
    assert.deepEqual(usage.downloads, { bytes: 3, files: 1 })
    assert.deepEqual(usage.cache, { bytes: 7, files: 2 })
    assert.deepEqual(await measureFiles(path.join(locations.store, 'models', 'linked')), { bytes: 0, files: 0 })
    assert.deepEqual(await measureFiles(path.join(locations.store, 'models', 'linked', 'file')), { bytes: 0, files: 0 })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
