import assert from 'node:assert/strict'
import fs from 'node:fs'
import { t as listTar, x as extractTar } from 'tar'
import { safePath } from './restore-playback-sources.mjs'

// Inspect before extraction; neither symlinks nor tar hardlinks are source files.
// Legacy ANGLE archives include compiler dependency sources. New rebuild-only
// archives use a smaller cap; neither format relaxes path/link validation.
export const angleSourceLimits = Object.freeze({ maxBytes: 8 * 1024 ** 3, maxEntries: 200000 })
export const angleRebuildLimits = Object.freeze({ maxBytes: 64 * 1024 ** 2, maxEntries: 20000 })
export async function unpackPlaybackSources(archive, destination, { maxBytes = 2 * 1024 ** 3, maxEntries = 50000 } = {}) {
  const seen = new Set()
  let total = 0
  await listTar({ file: archive, strict: true, filter(name, entry) {
    try {
      assert.ok(['File', 'Directory'].includes(entry.type), 'Source archive contains links/special files')
      const clean = name.replace(/^\.\//, '').replace(/\/$/, '')
      if (clean && clean !== '.') {
        safePath(clean)
        assert.ok(!seen.has(clean), 'Duplicate source archive entry')
        seen.add(clean)
      }
      total += entry.size
      assert.ok(total <= maxBytes && seen.size <= maxEntries, 'Source archive exceeds bounds')
      return true
    } catch (error) { this.abort(error); return false }
  } })
  fs.mkdirSync(destination)
  await extractTar({ file: archive, cwd: destination, strict: true, preserveOwner: false })
}
