import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { loadUpdaterConfig } from './config'
import { ProcessUpdateDeployment } from './processDeployment'
import { ReleaseStore } from './releaseStore'
import { BusinessSupervisor, clearStaleManagedMarker } from './supervisor'
import { MANAGED_LOCK } from './storage'
import { ServerUpdateManager, readLimitedJson } from './updateManager'
import { sha256 } from './manifest'
import { signedUpdateSchema } from '@shared/serverUpdateTypes'

const controlSchema = z.discriminatedUnion('action', [
  z.object({ protocolVersion: z.literal(1), action: z.literal('status') }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('check') }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('prepare') }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('import'), signed: signedUpdateSchema }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('install'), jobId: z.uuid() }).strict()
])
let cleanup: (() => Promise<void>) | undefined

async function fetchJson(url: string | URL, limit: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } })
  if (!response.ok || !response.body) throw new Error('官方更新信息下载失败')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('官方更新信息超过允许大小')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0] && !args[0].startsWith('--') ? args.shift()! : 'start'
  if (!['start', 'pair', 'bind', 'recover'].includes(command) || (args.length && (args.length !== 2 || args[0] !== '--config'))) throw new Error('用法：node index.js start|pair|bind|recover [--config /config/server.json]')
  const file = args[1] || process.env.JAVDEX_SERVER_CONFIG || '/config/server.json'
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '22') throw new Error('托管运行环境需要 Linux 和 Node.js 22')
  if (process.getuid?.() !== 0) throw new Error('管理入口需由容器内 root 运行，业务子进程使用独立非 root UID')
  const config = loadUpdaterConfig(file)
  if (config.businessUid === 0) throw new Error('托管业务子进程不能使用 root UID')
  const releases = new ReleaseStore(config)
  const supervisor = new BusinessSupervisor(config)
  cleanup = () => supervisor.shutdown()
  const deployment = new ProcessUpdateDeployment(config, releases, supervisor)
  if (command === 'pair') {
    if (!config.publicUrl) throw new Error('请先配置 JAVDEX_UPDATE_PUBLIC_URL 为客户端可访问的 HTTPS 地址')
    const { identity } = await deployment.inspect()
    const certificate = new X509Certificate(fs.readFileSync(path.join(config.stateDir, 'certificate.pem')))
    const token = fs.readFileSync(path.join(config.stateDir, 'token'), 'utf8').trim()
    process.stdout.write(`${JSON.stringify({ protocolVersion: 1, url: config.publicUrl, certificateSha256: sha256(certificate.raw), token, serverId: identity.serverId, catalogId: identity.catalogId })}\n`)
    return
  }
  if (command === 'start' && process.env.JAVDEX_MANAGER_LOCK_HELD !== '1') {
    if (!fs.existsSync(config.dataDir)) { fs.mkdirSync(config.dataDir, { recursive: true }); fs.chownSync(config.dataDir, config.businessUid, config.businessGid) }
    const child = spawn('flock', ['--nonblock', '--no-fork', path.join(config.dataDir, MANAGED_LOCK), process.execPath, fileURLToPath(import.meta.url), 'start', '--config', file], {
      stdio: 'inherit', env: { ...process.env, JAVDEX_MANAGER_LOCK_HELD: '1' }
    })
    const forward = (): void => { child.kill('SIGTERM') }
    process.on('SIGTERM', forward)
    process.on('SIGINT', forward)
    const code = await new Promise<number>((resolve, reject) => { child.once('error', () => reject(new Error('容器运行外壳缺少 flock'))); child.once('close', code => resolve(code ?? 1)) })
    process.exitCode = code
    return
  }
  const certificateFile = path.join(config.stateDir, 'certificate.pem')
  const privateFile = path.join(config.stateDir, 'private.pem')
  const tokenFile = path.join(config.stateDir, 'token')
  const existing = [certificateFile, privateFile, tokenFile].filter(file => fs.existsSync(file)).length
  if (existing !== 0 && existing !== 3) throw new Error('更新凭据初始化不完整，保留现场；不会覆盖已有配对')
  if (existing === 0) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '3650', '-subj', '/CN=JavdexUpdater', '-keyout', privateFile, '-out', certificateFile], { stdio: 'ignore' })
    fs.chmodSync(privateFile, 0o600)
    fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('更新凭据无效')
  await releases.bootstrap()
  if (command === 'bind' || command === 'recover') {
    const current = releases.current()!
    const child = spawn(process.execPath, [path.join(releases.directory(current), 'index.js'), command, '--config', file], {
      cwd: releases.directory(current), stdio: 'inherit', uid: config.businessUid, gid: config.businessGid,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
    })
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
    return
  }
  clearStaleManagedMarker(config)
  const manager = new ServerUpdateManager(config.stateDir, config.releaseKeys, deployment)
  const serverRef: { current?: ReturnType<typeof createServer> } = {}
  let closing = false
  const stop = (): void => {
    if (closing) return
    closing = true
    serverRef.current?.close(); serverRef.current?.closeAllConnections()
    void Promise.all([manager.shutdown(), supervisor.shutdown()]).catch(() => { process.exitCode = 1 })
  }
  cleanup = async () => { serverRef.current?.close(); serverRef.current?.closeAllConnections(); await Promise.all([manager.shutdown(), supervisor.shutdown()]) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  await manager.recover()
  if (!closing && !manager.recoveryRequired) await deployment.startCurrent()
  if (closing) return
  let commandBusy = false
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const reply = (status: number, value: unknown): void => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(JSON.stringify(value))
    }
    const bearer = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
    if (request.headers.origin || !bearer || !timingSafeEqual(Buffer.from(bearer), Buffer.from(token))) { reply(401, { error: '更新授权无效' }); return }
    const url = new URL(request.url ?? '/', 'https://updater.invalid')
    try {
      const upload = /^\/update\/v1\/uploads\/([a-f0-9-]{36})$/.exec(url.pathname)
      if (upload && request.method === 'PUT') {
        if (commandBusy) throw new Error('已有更新请求正在处理，请查询任务后续传')
        const offset = Number(url.searchParams.get('offset'))
        if (!Number.isSafeInteger(offset) || offset < 0 || !url.searchParams.has('offset')) throw new Error('无效上传偏移')
        reply(200, await manager.upload(z.uuid().parse(upload[1]), offset, request))
        return
      }
      if (url.pathname !== '/update/v1/control' || request.method !== 'POST') { reply(404, { error: '更新接口不存在' }); return }
      const input = controlSchema.parse(await readLimitedJson(request))
      if (input.action === 'status') { reply(200, await manager.status()); return }
      if (commandBusy) throw new Error('已有更新请求正在处理')
      commandBusy = true
      try {
        if (input.action === 'check') {
          const status = await manager.status()
          const release = await fetchJson('https://api.github.com/repos/JavdexLabs/Javdex/releases/latest', 1024 * 1024) as { assets?: Array<{ name: string; browser_download_url: string }> }
          const platform = status.platform?.replace('/', '-')
          const asset = release.assets?.find(a => a.name === `Javdex-server-update-${platform}.json`)
          if (!asset) throw new Error('当前正式发布尚未提供服务端更新清单')
          const source = new URL(asset.browser_download_url)
          if (source.protocol !== 'https:' || source.hostname !== 'github.com' || !source.pathname.startsWith('/JavdexLabs/Javdex/releases/download/')) throw new Error('更新清单来源无效')
          reply(200, await manager.setTarget(await fetchJson(source, 65536)))
        } else if (input.action === 'import') reply(200, await manager.beginOffline(input.signed))
        else if (input.action === 'prepare') reply(200, await manager.prepare())
        else reply(200, await manager.install(input.jobId))
      } finally { commandBusy = false }
    } catch (error) { reply(409, { error: error instanceof Error ? error.message : '更新请求失败' }) }
  }
  const server = createServer({ key: fs.readFileSync(privateFile), cert: fs.readFileSync(certificateFile), minVersion: 'TLSv1.2' }, (request, response) => {
    void handle(request, response).catch(() => { if (!response.destroyed && !response.writableEnded) { response.writeHead(500); response.end() } })
  })
  serverRef.current = server
  server.requestTimeout = 120_000
  server.headersTimeout = 15_000
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(config.port, config.listenHost, resolve) })
  process.stdout.write(`Javdex 容器内管理进程正在监听 ${config.listenHost}:${config.port}\n`)
}

void main().catch(async error => { process.stderr.write(`${(error as Error).message}\n`); await cleanup?.(); process.exitCode = 1 })
