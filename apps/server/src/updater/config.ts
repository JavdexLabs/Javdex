import fs from 'node:fs'
import path from 'node:path'
import { createPublicKey, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import { z } from 'zod'
import { writeJsonAtomic } from './files'

export interface UpdaterConfig {
  runtimeDir: string
  stateDir: string
  releasesDir: string
  seedDir: string
  serverConfigPath: string
  serverUrl: string
  healthHost: string
  dataDir: string
  imagesDir: string
  listenHost: string
  port: number
  publicUrl: string | null
  gateway?: { origin: string; token: string }
  releaseKeys: Record<string, string>
  stopTimeoutSeconds: number
  businessUid: number
  businessGid: number
}
const absolute = (value: string): string => {
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) throw new Error('需要具体的绝对路径')
  let ancestor = path.resolve(value)
  const tail: string[] = []
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor) }
  return path.join(fs.realpathSync(ancestor), ...tail)
}
export function contained(file: string, root: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
export function loadUpdaterConfig(file: string, options: { env?: NodeJS.ProcessEnv; seedDir?: string } = {}): UpdaterConfig {
  const env = options.env ?? process.env
  const serverConfigPath = absolute(file)
  const input = JSON.parse(fs.readFileSync(file, 'utf8')) as { dataDir?: string; imagesDir?: string; port?: number; accessHosts?: string[] }
  const dataDir = absolute(env.JAVDEX_DATA_DIR || input.dataDir || '/data')
  const imagesDir = absolute(env.JAVDEX_IMAGES_DIR || input.imagesDir || path.join(dataDir, 'media_assets'))
  if (imagesDir !== dataDir && contained(dataDir, imagesDir)) throw new Error('图片目录不能包含资料目录，请使用资料目录内的图片目录或独立目录')
  const runtimeDir = absolute(env.JAVDEX_RUNTIME_DIR || '/program')
  if (contained(runtimeDir, dataDir) || contained(dataDir, runtimeDir) || contained(runtimeDir, imagesDir) || contained(imagesDir, runtimeDir)) throw new Error('程序与更新目录必须和资料、图片目录分离')
  const unified = Boolean(env.JAVDEX_PUBLIC_URL)
  const serverPort = z.coerce.number().int().min(1).max(65535).parse(unified ? (env.JAVDEX_INTERNAL_PORT || 8098) : (env.JAVDEX_LISTEN_PORT || input.port || 8096))
  const host = unified ? '127.0.0.1' : env.JAVDEX_ACCESS_HOSTS?.split(',')[0]?.trim() || input.accessHosts?.[0] || '127.0.0.1'
  const healthHost = `${isIP(host) === 6 ? `[${host}]` : host}:${serverPort}`
  const port = z.coerce.number().int().min(1024).max(65535).parse(unified ? (env.JAVDEX_LISTEN_PORT || input.port || 8096) : (env.JAVDEX_UPDATE_PORT || 8097))
  if (port === serverPort) throw new Error('业务与更新端口不能相同')
  const publicUrl = (env.JAVDEX_PUBLIC_URL || env.JAVDEX_UPDATE_PUBLIC_URL)?.trim() || null
  if (publicUrl) {
    const url = new URL(publicUrl)
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('公开地址必须是无路径的 HTTPS 地址')
  }
  const seedDir = absolute(options.seedDir || env.JAVDEX_SERVER_SEED_DIR || '/app')
  const keysFile = env.JAVDEX_UPDATE_KEYS_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-keys.json')
  const releaseKeys = z.record(z.string().regex(/^[\w-]{1,64}$/), z.string().min(1).max(8192)).parse(fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : {})
  for (const key of Object.values(releaseKeys)) if (createPublicKey(key).asymmetricKeyType !== 'ed25519') throw new Error('更新发布公钥必须使用 Ed25519')
  const stopTimeoutSeconds = z.coerce.number().int().min(1).max(600).parse(env.JAVDEX_UPDATE_STOP_TIMEOUT || 120)
  const businessUid = z.coerce.number().int().nonnegative().parse(env.JAVDEX_SERVER_UID || 1000)
  const businessGid = z.coerce.number().int().nonnegative().parse(env.JAVDEX_SERVER_GID || 1000)
  const marker = path.join(runtimeDir, '.javdex-program')
  if (fs.existsSync(runtimeDir)) {
    if (fs.lstatSync(runtimeDir).isSymbolicLink()) throw new Error('程序目录不能是符号链接')
    if (fs.readdirSync(runtimeDir).length && (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'Javdex managed program v1\n')) throw new Error('请选择空的专用程序目录，不能复用其他资料目录')
  }
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o755 })
  // An empty host bind mount may be owned by the business UID. Protect its
  // parent as well as private state so the business cannot replace directories.
  const rootManager = process.getuid?.() === 0
  if (rootManager) fs.chownSync(runtimeDir, 0, 0)
  fs.chmodSync(runtimeDir, 0o755)
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'Javdex managed program v1\n', { flag: 'wx', mode: 0o644 })
  const stateDir = path.join(runtimeDir, 'state')
  const releasesDir = path.join(runtimeDir, 'releases')
  for (const [directory, mode] of [[stateDir, 0o700], [releasesDir, 0o755]] as const) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('托管目录不能是符号链接')
    if (rootManager && fs.existsSync(directory) && fs.statSync(directory).uid !== 0) throw new Error('已有托管目录不是管理进程所有，请保留现场并核对程序卷权限')
    fs.mkdirSync(directory, { recursive: true, mode }); fs.chmodSync(directory, mode)
  }
  const binding = { format: 1, serverConfigPath, dataDir, imagesDir }
  const bindingFile = path.join(stateDir, 'deployment.json')
  if (fs.existsSync(bindingFile)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))) !== JSON.stringify(binding)) throw new Error('程序卷已绑定另一份资料库部署，不能复用更新状态')
  } else writeJsonAtomic(bindingFile, binding)
  return { runtimeDir, stateDir, releasesDir, seedDir, serverConfigPath, dataDir, imagesDir, serverUrl: `http://127.0.0.1:${serverPort}`, healthHost, listenHost: env.JAVDEX_UPDATE_LISTEN_HOST || '0.0.0.0', port, publicUrl, releaseKeys, stopTimeoutSeconds, businessUid, businessGid,
    ...(unified ? { gateway: { origin: new URL(publicUrl!).origin, token: randomBytes(32).toString('hex') } } : {}) }
}
