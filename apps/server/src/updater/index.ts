import fs from 'node:fs'
import path from 'node:path'
import { createDualProtocolServer } from './dualProtocolServer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { X509Certificate } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import semver from 'semver'
import { loadUpdaterConfig } from './config'
import { ProcessUpdateDeployment } from './processDeployment'
import { ReleaseStore } from './releaseStore'
import { BusinessSupervisor, clearStaleManagedMarker } from './supervisor'
import { MANAGED_LOCK } from './storage'
import { ServerUpdateManager, readLimitedJson } from './updateManager'
import { sha256 } from './manifest'
import { signedUpdateSchema } from '@shared/serverUpdateTypes'
import { discoverUpgrade } from './upgradeDiscovery'
import { serverUpgradeVersionSchema } from '@shared/serverUpdateTypes'
import { gatewayRequestAllowed, gatewayRouteAllowed, proxyBusiness } from './gateway'
import { ConnectionPairing } from './connectionPairing'
import { requestBusiness } from './businessHttp'
import { connectionClaimSchema } from '@shared/serverUpdateTypes'
import { authorizeDeviceUpdate, readDeviceUpdateBearer } from './deviceAuthorization'
import { businessProcessCommand } from './businessProcess'
import { serveServerEnvironment } from './environmentHttp'
import { ServerEnvironmentMismatchError } from '@shared/serverEnvironment'

const controlSchema = z.discriminatedUnion('action', [
  z.object({ protocolVersion: z.literal(1), action: z.literal('status') }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('check'), targetVersion: serverUpgradeVersionSchema }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('prepare'), targetVersion: serverUpgradeVersionSchema }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('import'), signed: signedUpdateSchema, targetVersion: serverUpgradeVersionSchema }).strict(),
  z.object({ protocolVersion: z.literal(1), action: z.literal('install'), jobId: z.uuid(), targetVersion: serverUpgradeVersionSchema }).strict()
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
  if (!['start', 'token'].includes(command) || (args.length && (args.length !== 2 || args[0] !== '--config'))) throw new Error('用法：node index.js start|token [--config /config/server.json]')
  const file = args[1] || process.env.JAVDEX_SERVER_CONFIG || '/config/server.json'
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '22') throw new Error('托管运行环境需要 Linux 和 Node.js 22')
  if (process.getuid?.() !== 0) throw new Error('管理入口需由容器内 root 运行，业务子进程使用独立非 root UID')
  const config = loadUpdaterConfig(file)
  if (config.businessUid === 0) throw new Error('托管业务子进程不能使用 root UID')
  const releases = new ReleaseStore(config)
  const supervisor = new BusinessSupervisor(config)
  cleanup = () => supervisor.shutdown()
  const deployment = new ProcessUpdateDeployment(config, releases, supervisor)
  const pairing = new ConnectionPairing(config.stateDir)
  if (command === 'token') {
    await deployment.inspect()
    const current = releases.directory(releases.current()!)
    const business = businessProcessCommand(config, [path.join(current, 'index.js'), 'token', '--config', file])
    const issued = execFileSync(business.file, business.args, {
      cwd: current, ...business.credentials, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    process.stdout.write(`${pairing.issue(JSON.parse(issued)).code}\n`)
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
  const existing = [certificateFile, privateFile].filter(file => fs.existsSync(file)).length
  if (existing !== 0 && existing !== 2) throw new Error('证书初始化不完整，保留现场；不会覆盖已有配对')
  if (existing === 0) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '3650', '-subj', '/CN=JavdexUpdater', '-keyout', privateFile, '-out', certificateFile], { stdio: 'ignore' })
    fs.chmodSync(privateFile, 0o600)
  }
  let manager: ServerUpdateManager | undefined
  let startupFailed = false
  const serverRef: { current?: ReturnType<typeof createDualProtocolServer> } = {}
  let closing = false
  const stop = (): void => {
    if (closing) return
    closing = true
    serverRef.current?.close(); serverRef.current?.closeAllConnections()
    void Promise.all([manager?.shutdown(), supervisor.shutdown()]).catch(() => { process.exitCode = 1 })
  }
  cleanup = async () => { serverRef.current?.close(); serverRef.current?.closeAllConnections(); await Promise.all([manager?.shutdown(), supervisor.shutdown()]) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  let commandBusy = true
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const reply = (status: number, value: unknown): void => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(JSON.stringify(value))
    }
    const url = new URL(request.url ?? '/', 'https://updater.invalid')
    if (!gatewayRequestAllowed(request, config.gateway.origin)) { reply(403, { error: '访问地址或来源无效' }); return }
    if (!gatewayRouteAllowed(request)) { reply(403, { error: '此接口仅支持 HTTPS' }); return }
    if (serveServerEnvironment(request, response)) return
    if (url.pathname.startsWith('/runtime/')) { reply(404, { error: '运行环境接口不存在' }); return }
    if (!manager || startupFailed) { reply(503, { code: 'BUSINESS_NOT_READY', error: '服务端正在启动或需要人工核对，请查看容器日志' }); return }
    if (!url.pathname.startsWith('/update/') && !url.pathname.startsWith('/connect/')) {
      proxyBusiness(request, response, config.serverUrl, config.healthHost, config.gateway)
      return
    }
    if (url.pathname === '/connect/v1/claim' && request.method === 'POST') {
      if (request.headers.origin || commandBusy) { reply(409, { error: '启动或更新中，请稍后授权' }); return }
      try {
        const input = connectionClaimSchema.parse(await readLimitedJson(request, 4096))
        const current = releases.descriptor(releases.directory(releases.current()!))
        if (input.appVersion !== current.version) throw new Error('连接需使用与服务端相同版本的桌面客户端')
        const result = await pairing.claim(input, async (issued, candidate) => {
          const identity = (await deployment.inspect()).identity
          if (identity.serverId !== issued.serverId || identity.catalogId !== issued.catalogId) throw new Error('资料库身份已变化，请重新生成配对信息')
          const claimed = await requestBusiness(new URL('/manage/v1/writer.claim', config.serverUrl), config.healthHost, {
            appVersion: current.version, body: JSON.stringify({ serverId: issued.serverId, catalogId: issued.catalogId,
              input: { kind: issued.kind, oneTimeToken: issued.oneTimeToken, candidate } })
          })
          const receipt = JSON.parse(claimed.body) as { status?: string; bound?: boolean }
          if (!claimed.ok || receipt.status !== 'consumed' || !receipt.bound) throw new Error('写入授权未完成或已失效，请重试或生成新的令牌')
          return { protocolVersion: 1, url: config.gateway.origin, certificateSha256: sha256(new X509Certificate(fs.readFileSync(certificateFile)).raw),
            serverId: identity.serverId, catalogId: identity.catalogId }
        })
        reply(200, result)
      } catch (error) { reply(409, { error: error instanceof Error ? error.message : '配对失败' }) }
      return
    }
    const bearer = readDeviceUpdateBearer(request.headers.authorization)
    const authorized = bearer && authorizeDeviceUpdate(releases.directory(releases.current()!), config.dataDir, bearer)
    if (request.headers.origin || !authorized) { reply(401, { error: '更新授权无效' }); return }
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
      if (!authorizeDeviceUpdate(releases.directory(releases.current()!), config.dataDir, bearer!)) { reply(401, { error: '设备授权已撤销' }); return }
      if (input.action === 'status') { reply(200, await manager.status()); return }
      if (commandBusy) throw new Error('已有更新请求正在处理')
      commandBusy = true
      try {
        if (input.action === 'check') {
          const status = await manager.status()
          const signed = await discoverUpgrade(status.platform, input.targetVersion, url => fetchJson(url, 1024 * 1024))
          reply(200, await manager.setTarget(signed, input.targetVersion))
        } else if (input.action === 'import') reply(200, await manager.beginOffline(input.signed, input.targetVersion))
        else if (input.action === 'prepare') reply(200, await manager.prepare(input.targetVersion))
        else reply(200, await manager.install(input.jobId, input.targetVersion))
      } finally { commandBusy = false }
    } catch (error) {
      reply(409, { error: error instanceof Error ? error.message : '更新请求失败', ...(error instanceof ServerEnvironmentMismatchError ? {
        code: error.code, currentEnvironmentVersion: error.currentEnvironmentVersion, requiredEnvironmentVersion: error.requiredEnvironmentVersion
      } : {}) })
    }
  }
  const server = createDualProtocolServer({ key: fs.readFileSync(privateFile), cert: fs.readFileSync(certificateFile), minVersion: 'TLSv1.2' }, (request, response) => {
    void handle(request, response).catch(() => { if (!response.destroyed && !response.writableEnded) { response.writeHead(500); response.end() } })
  })
  serverRef.current = server
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(config.port, config.listenHost, resolve) })
  process.stdout.write(`Javdex 容器内管理进程正在监听 ${config.listenHost}:${config.port}\n`)
  try {
    // Keep discovery reachable even when old business code or persistent state
    // cannot start. It must not require opening the catalog or pairing first.
    await releases.bootstrap()
    if (closing) return
    clearStaleManagedMarker(config)
    manager = new ServerUpdateManager(config.stateDir, config.releaseKeys, deployment)
    await manager.recover()
    if (!closing && !manager.recoveryRequired) {
      const image = releases.imageRelease()
      const current = releases.descriptor(releases.directory(releases.current()!))
      // A fresh volume has no database yet; bootstrap already selected this image.
      if (semver.gt(image.release.version, current.version)) {
        await manager.installImage(image.release, image.bytes, () => releases.prepareImage(image.release))
        const status = await manager.status(false)
        process.stdout.write(`镜像业务升级状态：${status.job?.phase ?? '未执行'}${status.job?.message ? `（${status.job.message}）` : ''}\n`)
      }
    }
    if (!closing && !manager.recoveryRequired) await deployment.startCurrent()
  } catch (error) {
    startupFailed = true
    process.exitCode = 1
    await supervisor.shutdown().catch(() => {})
    process.stderr.write(`服务端启动未完成，保持维护状态并保留运行环境查询；请人工核对。原因：${error instanceof Error ? error.message : '启动失败'}\n`)
  } finally { commandBusy = false }
}

void main().catch(async error => { process.stderr.write(`${(error as Error).message}\n`); await cleanup?.(); process.exitCode = 1 })
