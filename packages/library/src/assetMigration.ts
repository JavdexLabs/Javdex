import type { AssetCryptoProgress } from '@shared/libraryTypes'
import { remapAssetPath } from '@library/db/videoRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'

type ProgressFn = (p: AssetCryptoProgress) => void

function filesToMigrate(enable: boolean, rels: string[]): string[] {
  if (enable) {
    return rels.filter((rel) => !rel.toLowerCase().endsWith('.enc'))
  }
  return rels.filter((rel) => rel.toLowerCase().endsWith('.enc'))
}

/** Batch encrypt or decrypt all assets under media_assets. Updates DB paths. */
export async function migrateAssetStorage(enable: boolean, onProgress: ProgressFn): Promise<void> {
  const targets = filesToMigrate(enable, mediaAssetStore.listStoredImageAssetRels())
  const phase = enable ? 'encrypt' : 'decrypt'

  onProgress({
    phase,
    current: 0,
    total: targets.length,
    currentFile: '',
    status: 'running'
  })

  for (let i = 0; i < targets.length; i++) {
    const rel = targets[i]
    onProgress({
      phase,
      current: i + 1,
      total: targets.length,
      currentFile: rel,
      status: 'running'
    })

    try {
      const rewrite = enable
        ? mediaAssetStore.encryptStoredAsset(rel)
        : mediaAssetStore.decryptStoredAsset(rel)
      if (rewrite) remapAssetPath(rewrite.fromRel, rewrite.toRel)
    } catch (err) {
      onProgress({
        phase,
        current: i + 1,
        total: targets.length,
        currentFile: rel,
        status: 'error',
        error: (err as Error).message
      })
      throw err
    }

    if (i % 20 === 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  if (!enable) mediaAssetStore.clearPathAliases()

  onProgress({
    phase,
    current: targets.length,
    total: targets.length,
    currentFile: '',
    status: 'done'
  })
}
