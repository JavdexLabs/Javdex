import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '@library/db/database'
import { resolveLibraryUserDataPath } from '@library/runtime/host'
import { backupControl, backupFile, writeBackupChunk, recoverBackupOperations, type BackupHost } from '@library/catalog/catalogBackup'
import { BACKUP_CHUNK_BYTES } from '@shared/protocol/backup'
import type { CatalogBackupCommands } from '../../application/catalogBackend'
import { localCatalogIdentityPath } from '../../desktop/localCatalogIdentity'

export function persistRestoredLocalIdentity(id: string, userDataPath = resolveLibraryUserDataPath()): void {
  const target = localCatalogIdentityPath(userDataPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const fd = fs.openSync(`${target}.tmp`, 'w')
  try { fs.writeFileSync(fd, JSON.stringify({ catalogId: id })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(`${target}.tmp`, target)
}

export function createLocalBackup(appVersion: string, onRestored: (id: string) => void): CatalogBackupCommands {
  const host: BackupHost = { mode: 'local', appVersion, onRestored(id) {
    persistRestoredLocalIdentity(id)
    onRestored(id)
  } }
  recoverBackupOperations(host, getDb())
  return {
    async request(input) { return backupControl(host, getDb(), input) },
    async upload(id, offset, data) { return writeBackupChunk(host, id, 'local', offset, data) },
    async download(id, offset) {
      const file = backupFile(host, id, 'local')
      const size = Math.min(BACKUP_CHUNK_BYTES, fs.statSync(file).size - offset)
      if (size <= 0) return Buffer.alloc(0)
      const data = Buffer.alloc(size); const fd = fs.openSync(file, 'r')
      try { fs.readSync(fd, data, 0, size, offset) } finally { fs.closeSync(fd) }
      return data
    }
  }
}
