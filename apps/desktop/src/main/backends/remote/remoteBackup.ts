import fs from 'node:fs'
import path from 'node:path'
import { ManageHttpClient } from '@http/manageClient'
import { BACKUP_CHUNK_BYTES, type BackupResponse } from '@shared/protocol/backup'
import type { HandshakeResult } from '@shared/protocol/handshake'
import { isStructuredError, structuredError } from '@shared/protocol/errors'
import type { CatalogBackupCommands } from '../../application/catalogBackend'
import type { RemoteCatalogBackendOptions } from './remoteCatalogBackend'

export function createRemoteBackup(options: RemoteCatalogBackendOptions, refresh: () => Promise<unknown>, connectionSignal: () => AbortSignal = () => new AbortController().signal): CatalogBackupCommands {
  const client = new ManageHttpClient(options)
  const pendingPath = options.userDataPath ? path.join(options.userDataPath, 'backup-connection-recovery.json') : null
  async function connection(signal: AbortSignal) {
    const hello = await client.post('handshake.get', { input: {} }, { sendAppVersion: false, signal: AbortSignal.any([signal, AbortSignal.timeout(client.timeoutMs)]) }) as HandshakeResult
    if (hello.appVersion !== options.appVersion) throw structuredError('VERSION_MISMATCH', '桌面与服务器版本不一致')
    let secret = await options.credentials.readWriterSecret(hello.identity.catalogId)
    if (!secret && pendingPath && fs.existsSync(pendingPath)) {
      const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { catalogId: string; serverId: string; baseUrl: string }
      if (pending.serverId === hello.identity.serverId && pending.baseUrl === options.baseUrl) secret = await options.credentials.readWriterSecret(pending.catalogId)
    }
    if (!secret) throw structuredError('AUTH_REQUIRED', '请先领取服务端写入凭据')
    signal.throwIfAborted()
    return { hello, secret }
  }
  async function transfer(id: string, offset: number, body?: Buffer): Promise<Response> {
    const signal = connectionSignal()
    const { secret } = await connection(signal)
    const response = await fetch(`${client.baseUrl}/manage/v1/backups/${encodeURIComponent(id)}?offset=${offset}`, {
      method: body ? 'PUT' : 'GET',
      headers: { Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': options.appVersion, Origin: client.origin, 'Content-Type': 'application/octet-stream' },
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'error'
    })
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null)
      if (isStructuredError(error)) throw error
      throw structuredError(response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'CONNECTION_UNAVAILABLE', '备份传输失败，请检查连接与写入授权')
    }
    return response
  }
  return {
    async request(input) {
      const signal = connectionSignal()
      const { hello, secret } = await connection(signal)
      if (input.action === 'restore' && pendingPath) {
        fs.mkdirSync(path.dirname(pendingPath), { recursive: true })
        fs.writeFileSync(pendingPath, JSON.stringify({ catalogId: hello.identity.catalogId, serverId: hello.identity.serverId, baseUrl: options.baseUrl, id: input.id }), { mode: 0o600 })
      }
      const result = await client.post('backup.control', { serverId: hello.identity.serverId, catalogId: hello.identity.catalogId, input }, { bearer: secret, signal: AbortSignal.any([signal, AbortSignal.timeout(client.timeoutMs)]) }) as BackupResponse
      const finished = result.jobs.find(job => job.phase === 'completed' && job.newCatalogId === hello.identity.catalogId)
      if (finished && !(await options.credentials.readWriterSecret(hello.identity.catalogId))) {
        await options.credentials.writeWriterSecret(hello.identity.catalogId, secret)
        await refresh()
      }
      return result
    },
    async upload(id, offset, data) { return (await (await transfer(id, offset, data)).json() as { offset: number }).offset },
    async download(id, offset) {
      const response = await transfer(id, offset)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('备份下载响应为空')
      const chunks: Buffer[] = []; let bytes = 0
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break
          bytes += part.value.byteLength
          if (bytes > BACKUP_CHUNK_BYTES) throw new Error('备份响应分块过大')
          chunks.push(Buffer.from(part.value))
        }
      } finally { await reader.cancel() }
      return Buffer.concat(chunks)
    }
  }
}
