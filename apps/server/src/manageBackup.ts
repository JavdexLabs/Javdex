import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'
import { backupControl, beginBackupDownload, writeBackupChunk, type BackupHost } from '@library/catalog/catalogBackup'
import { readCatalogIdentity } from '@library/catalog/catalogIdentity'
import { digestToken, digestEquals } from '@library/catalog/catalogSecrets'
import { backupRequestSchema, BACKUP_CHUNK_BYTES } from '@shared/protocol/backup'
import { structuredError } from '@shared/protocol/errors'
import type { ManageHttpContext, ManageBackupFileContext } from '@http/manage'
import { parseManageRequest } from '@shared/manage/parse'
import { SERVER_APP_VERSION } from './appVersion'

let onRestored: ((catalogId: string) => void) | undefined
export function setBackupRestoredHandler(handler: typeof onRestored): void { onRestored = handler }
const host: BackupHost = { mode: 'remote', appVersion: SERVER_APP_VERSION, onRestored: id => onRestored?.(id) }
function authorize(secret: string | null, db: Database.Database): string {
  if (!secret) throw structuredError('AUTH_REQUIRED', '需要写入凭据')
  const row = db.prepare('SELECT secret_digest, writer_epoch FROM catalog_writer_credentials WHERE superseded_at IS NULL ORDER BY writer_epoch DESC LIMIT 1').get() as { secret_digest: string; writer_epoch: number } | undefined
  if (!row || !digestEquals(row.secret_digest, digestToken(secret)) || readCatalogIdentity(db)?.writerEpoch !== row.writer_epoch) throw structuredError('AUTH_REQUIRED', '写入凭据已失效')
  return row.secret_digest
}
export function dispatchBackup(context: ManageHttpContext, db: Database.Database = getDb()): unknown {
  const parsed = parseManageRequest('backup.control', context.body)
  if (!parsed.success) throw structuredError('INVALID_INPUT', '备份请求格式无效')
  const body = parsed.data as { serverId: string; catalogId: string; input: unknown }
  const input = backupRequestSchema.parse(body.input)
  const identity = readCatalogIdentity(db)!
  const owner = authorize(context.bearerSecret, db)
  if (body.serverId !== identity.serverId) throw structuredError('INSTANCE_MISMATCH', '服务端已变化')
  // Only task discovery/status survives publication of a new catalog identity.
  if (!['list', 'status'].includes(input.action) && body.catalogId !== identity.catalogId) throw structuredError('CATALOG_MISMATCH', '目标资料库已变化')
  return backupControl(host, db, input, owner)
}
export async function transferBackup(context: ManageBackupFileContext, db: Database.Database = getDb()): Promise<{ file?: string; offset?: number; release?: () => void }> {
  const owner = authorize(context.bearerSecret, db)
  if (context.request.method === 'GET') return beginBackupDownload(host, context.id, owner)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of context.request) {
    size += chunk.length
    if (size > BACKUP_CHUNK_BYTES) throw structuredError('LIMIT_EXCEEDED', '上传分块过大')
    chunks.push(chunk as Buffer)
  }
  return { offset: writeBackupChunk(host, context.id, owner, context.offset, Buffer.concat(chunks)) }
}
