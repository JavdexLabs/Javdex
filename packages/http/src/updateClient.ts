import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { updaterPairingSchema, type UpdaterPairing, type ServerUpdateSnapshot, type SignedServerUpdate } from '@shared/serverUpdateTypes'

/** Cert pin is checked before creating a request containing deployment credentials. */
export class ServerUpdateClient {
  readonly pairing: UpdaterPairing
  constructor(pairing: UpdaterPairing) { this.pairing = updaterPairingSchema.parse(pairing) }
  private async request(endpoint: string, body: Buffer, method = 'POST'): Promise<ServerUpdateSnapshot> {
    const url = new URL(endpoint, this.pairing.url)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const connection = tls.connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
      const timer = setTimeout(() => { connection.destroy(); reject(new Error('更新助手连接超时')) }, 10_000)
      connection.once('error', () => { clearTimeout(timer); reject(new Error('无法连接更新助手')) })
      connection.once('secureConnect', () => {
        clearTimeout(timer)
        const cert = connection.getPeerCertificate().raw
        if (!cert || createHash('sha256').update(cert).digest('hex') !== this.pairing.certificateSha256) {
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
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ServerUpdateSnapshot & { error?: string }
            if (response.statusCode !== 200) throw new Error(parsed.error ?? '更新请求失败')
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
  control(action: 'status' | 'check' | 'prepare' | 'install', jobId?: string): Promise<ServerUpdateSnapshot> {
    return this.request('/update/v1/control', Buffer.from(JSON.stringify({ protocolVersion: 1, action, ...(jobId ? { jobId } : {}) })))
  }
  import(signed: SignedServerUpdate): Promise<ServerUpdateSnapshot> {
    return this.request('/update/v1/control', Buffer.from(JSON.stringify({ protocolVersion: 1, action: 'import', signed })))
  }
  upload(id: string, offset: number, chunk: Buffer): Promise<ServerUpdateSnapshot> {
    return this.request(`/update/v1/uploads/${encodeURIComponent(id)}?offset=${offset}`, chunk, 'PUT')
  }
}
