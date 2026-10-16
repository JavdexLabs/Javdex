import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { VerifyServerCertificate } from './pinnedFetch'
import { readUpdateBundle, verifyBundleArchive } from './updateBundle'
import { updaterPairingSchema, signedUpdateSchema, updateManifestSchema, serverUpgradeVersionSchema, type UpdaterPairing, type ServerUpdateSnapshot, type SignedServerUpdate } from '@shared/serverUpdateTypes'
import { assertServerEnvironmentVersion } from '@shared/serverEnvironment'

/** Preserve HTTP failure identity without changing authentication or retry policy. */
export class ServerUpdateRequestError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code?: string) { super(message) }
}

/** Upload only the inner archive; journal offsets exclude the transport header. */
export async function uploadServerUpdateBundle(client: Pick<ServerUpdateClient, 'import' | 'upload'>, fd: number, targetVersion: string): Promise<ServerUpdateSnapshot> {
  serverUpgradeVersionSchema.parse(targetVersion)
  const bundle = readUpdateBundle(fd)
  const signed = signedUpdateSchema.parse(bundle.signed)
  const manifest = updateManifestSchema.parse(JSON.parse(signed.payload))
  assertServerEnvironmentVersion(manifest.environmentVersion)
  if (manifest.version !== targetVersion) throw new Error(`升级包版本必须与此客户端 ${targetVersion} 一致`)
  if (bundle.archiveBytes !== manifest.archive.bytes) throw new Error('所选升级包大小与签名清单不一致')
  await verifyBundleArchive(fd, bundle.archiveOffset, bundle.archiveBytes, manifest.archive.sha256)
  // Import verifies the manager's baked-in trust root, expiry and target before
  // any archive bytes are uploaded. No public key is accepted from the file.
  let status = await client.import(signed, targetVersion)
  if (!status.job || status.job.totalBytes !== bundle.archiveBytes || status.job.version !== manifest.version
    || status.platform !== manifest.platform) throw new Error('升级任务与签名清单不一致')
  if (!Number.isSafeInteger(status.job.receivedBytes) || status.job.receivedBytes < 0 || status.job.receivedBytes > status.job.totalBytes)
    throw new Error('升级任务上传偏移无效')
  while (status.job?.phase === 'preparing' && status.job.receivedBytes < status.job.totalBytes) {
    const offset = status.job.receivedBytes
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('升级任务上传偏移无效')
    const buffer = Buffer.alloc(Math.min(8 * 1024 ** 2, status.job.totalBytes - offset))
    if (fs.readSync(fd, buffer, 0, buffer.length, bundle.archiveOffset + offset) !== buffer.length)
      throw new Error('发行包在上传期间发生变化，请重新选择')
    const next = await client.upload(status.job.id, offset, buffer)
    if (!next.job || next.job.id !== status.job.id || next.job.totalBytes !== status.job.totalBytes
      || next.job.receivedBytes !== offset + buffer.length) throw new Error('升级任务上传进度不一致，请查询状态后续传')
    status = next
  }
  return status
}

/** Cert pin is checked before creating a request containing deployment credentials. */
export class ServerUpdateClient {
  readonly pairing: UpdaterPairing
  constructor(pairing: UpdaterPairing, private readonly verifyCertificate?: VerifyServerCertificate) { this.pairing = updaterPairingSchema.parse(pairing) }
  private async request(endpoint: string, body: Buffer, method = 'POST'): Promise<ServerUpdateSnapshot> {
    const url = new URL(endpoint, this.pairing.url)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const connection = tls.connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('更新助手连接超时')) }, 10_000)
      connection.once('error', () => { clearTimeout(timer); reject(new Error('无法连接更新助手')) })
      connection.once('secureConnect', () => {
        clearTimeout(timer)
        const certificate = connection.getPeerCertificate()
        const cert = certificate.raw
        if (cert && this.verifyCertificate) {
          if (!(Date.parse(certificate.valid_from) <= Date.now() && Date.parse(certificate.valid_to) > Date.now())) { connection.destroy(); reject(new Error('服务器证书不在有效期内')); return }
          const error = connection.authorizationError as Error | string | null
          const code = typeof error === 'string' ? error : (error as NodeJS.ErrnoException | null)?.code
          if (!connection.authorized && code !== 'DEPTH_ZERO_SELF_SIGNED_CERT' && code !== 'SELF_SIGNED_CERT_IN_CHAIN') { connection.destroy(); reject(new Error('服务器的 HTTPS 证书校验失败')); return }
          void this.verifyCertificate(createHash('sha256').update(cert).digest('hex'), connection.authorized).then(() => resolve(connection), error => { connection.destroy(); reject(error) })
        } else if (!cert || createHash('sha256').update(cert).digest('hex') !== this.pairing.certificateSha256) {
          connection.destroy()
          reject(new Error('更新助手证书与配对信息不一致，请核对宿主机'))
        } else resolve(connection)
      })
    })
    const agent = new https.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method, agent,
        headers: { Authorization: `Bearer ${this.pairing.token}`, 'Content-Type': method === 'PUT' ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length }
      }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 1024 * 1024) response.destroy(new Error('更新响应过大'))
          else chunks.push(chunk)
        })
        response.once('error', () => reject(new Error('更新响应传输失败')))
        response.once('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ServerUpdateSnapshot & { error?: string; code?: unknown }
            if (response.statusCode !== 200) throw new ServerUpdateRequestError(parsed.error ?? '更新请求失败', response.statusCode ?? 0, typeof parsed.code === 'string' ? parsed.code : undefined)
            if (parsed.protocolVersion !== 1 || parsed.serverId !== this.pairing.serverId || parsed.catalogId !== this.pairing.catalogId) throw new Error('更新助手与已配对服务端身份不一致')
            resolve(parsed)
          } catch (error) { reject(error) }
        })
      })
      request.setTimeout(120_000, () => request.destroy(new Error('更新请求超时')))
      request.once('error', () => reject(new Error('更新请求连接中断，请查询状态后重试')))
      request.once('close', () => { agent.destroy(); socket.destroy() })
      request.end(body)
    })
  }
  control(action: 'status' | 'check' | 'prepare' | 'install', jobId?: string, options: { targetVersion?: string } = {}): Promise<ServerUpdateSnapshot> {
    if (action !== 'status') serverUpgradeVersionSchema.parse(options.targetVersion)
    return this.request('/update/v1/control', Buffer.from(JSON.stringify({ protocolVersion: 1, action, ...(jobId ? { jobId } : {}), ...options })))
  }
  import(signed: SignedServerUpdate, targetVersion: string): Promise<ServerUpdateSnapshot> {
    serverUpgradeVersionSchema.parse(targetVersion)
    return this.request('/update/v1/control', Buffer.from(JSON.stringify({ protocolVersion: 1, action: 'import', signed, targetVersion })))
  }
  upload(id: string, offset: number, chunk: Buffer): Promise<ServerUpdateSnapshot> {
    return this.request(`/update/v1/uploads/${encodeURIComponent(id)}?offset=${offset}`, chunk, 'PUT')
  }
}
