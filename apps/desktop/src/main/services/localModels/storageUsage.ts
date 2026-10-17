import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalFileUsage, LocalModelSnapshot } from '@shared/desktop/localModels'
import { localAiDirectories } from './modelStorage'

/** Read metadata only. Never traverse links, including links in a root's ancestors. */
export async function measureFiles(root: string, exclude = new Set<string>()): Promise<LocalFileUsage> {
  const total = { bytes: 0, files: 0 }
  let ancestor = path.resolve(root)
  while (true) {
    const stat = await fs.lstat(ancestor).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null })
    if (!stat || stat.isSymbolicLink()) return total
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  async function visit(file: string): Promise<void> {
    if (exclude.has(file)) return
    const stat = await fs.lstat(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null })
    if (!stat || stat.isSymbolicLink()) return
    if (stat.isFile()) { total.bytes += stat.size; total.files++; return }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return [] })
      for (const entry of entries) await visit(path.join(file, entry))
    }
  }
  await visit(root)
  return total
}
export async function measureLocalStorage(directory: string, locations: ReturnType<typeof localAiDirectories>, runtimeModelFamilies: string[]): Promise<NonNullable<LocalModelSnapshot['storage']>> {
  const runtimeModels = runtimeModelFamilies.map(family => path.join(directory, 'models', family))
  const [models, runtimes, downloads, staging, cache, work, ...auxiliary] = await Promise.all([
    measureFiles(path.join(directory, 'models'), new Set(runtimeModels)), measureFiles(path.join(directory, 'runtimes')),
    measureFiles(path.join(directory, 'downloads')), measureFiles(path.join(directory, 'staging')),
    measureFiles(locations.cache), measureFiles(locations.work), ...runtimeModels.map(root => measureFiles(root))
  ])
  for (const item of auxiliary) { runtimes.bytes += item.bytes; runtimes.files += item.files }
  cache.bytes += work.bytes; cache.files += work.files
  return { models, runtimes, downloads, staging, cache, checkedAt: new Date().toISOString() }
}
