import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CatalogIdentity } from '@shared/protocol/identity'

interface PersistedLocalCatalogIdentity {
  catalogId: string
}

export function localCatalogIdentityPath(userDataPath: string): string {
  return path.join(userDataPath, 'local-catalog-identity.json')
}

/** Stable per user-data catalog directory; never a filesystem path string. */
export function loadOrCreateLocalCatalogIdentity(filePath: string): CatalogIdentity {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedLocalCatalogIdentity
    if (typeof parsed.catalogId === 'string' && parsed.catalogId.trim()) {
      return { mode: 'local', catalogId: parsed.catalogId.trim() }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const catalogId = randomUUID()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify({ catalogId } satisfies PersistedLocalCatalogIdentity, null, 2)}\n`)
  fs.renameSync(temp, filePath)
  return { mode: 'local', catalogId }
}
