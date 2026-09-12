import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { hashPassword } from '@http/auth'

const USERNAME = /^[\w.-]{1,64}$/
const PASSWORD_HASH = /^[a-f0-9]{32}:[a-f0-9]{128}$/

const fileSchema = z
  .object({
    listenHost: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1024).max(65535).default(8096),
    accessHosts: z.array(z.string().min(1)).min(1),
    dataDir: z.string().min(1),
    imagesDir: z.string().min(1).optional(),
    staticRoot: z.string().min(1).optional(),
    mediaMounts: z.record(z.string().min(1), z.string().min(1)).default({}),
    web: z
      .object({
        username: z.string().regex(USERNAME),
        passwordHash: z.string().regex(PASSWORD_HASH).optional()
      })
      .strict()
  })
  .strict()

export interface ServerConfig {
  listenHost: string
  port: number
  accessHosts: string[]
  dataDir: string
  imagesDir: string
  staticRoot: string
  mediaMounts: Record<string, string>
  web: {
    username: string
    passwordHash: string
  }
}

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerConfigError'
  }
}

function requireAbsolute(label: string, value: string): string {
  if (!value.trim()) throw new ServerConfigError(`缺少 ${label}`)
  if (!path.isAbsolute(value)) {
    throw new ServerConfigError(`${label} 必须是绝对路径`)
  }
  return path.resolve(value)
}

function parseArgs(argv: string[]): { configPath?: string; command: 'start' | 'bind' } {
  const args = argv.slice(2)
  let command: 'start' | 'bind' = 'start'
  let configPath: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === 'start' || arg === 'bind') {
      command = arg
      continue
    }
    if (arg === '--config') {
      const next = args[i + 1]
      if (!next) throw new ServerConfigError('缺少 --config 路径')
      configPath = next
      i += 1
      continue
    }
    throw new ServerConfigError(`未知参数: ${arg}`)
  }
  return { configPath, command }
}

function readConfigFile(filePath: string): unknown {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    throw new ServerConfigError(`无法读取配置文件: ${filePath}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ServerConfigError('配置文件不是有效 JSON')
  }
}

export async function loadServerConfig(
  env: NodeJS.ProcessEnv,
  argv: string[],
  defaults?: { staticRoot?: string }
): Promise<{ command: 'start' | 'bind'; config: ServerConfig }> {
  const { configPath, command } = parseArgs(argv)
  const resolvedConfigPath = configPath ?? env.JAVDEX_SERVER_CONFIG
  if (!resolvedConfigPath) {
    throw new ServerConfigError('需要 --config 或 JAVDEX_SERVER_CONFIG')
  }
  const parsed = fileSchema.safeParse(readConfigFile(resolvedConfigPath))
  if (!parsed.success) {
    throw new ServerConfigError(`配置无效: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
  }
  const file = parsed.data
  const dataDir = requireAbsolute('dataDir', env.JAVDEX_DATA_DIR?.trim() || file.dataDir)
  const imagesDir = requireAbsolute(
    'imagesDir',
    env.JAVDEX_IMAGES_DIR?.trim() || file.imagesDir || path.join(dataDir, 'media_assets')
  )
  const staticCandidate = env.JAVDEX_STATIC_ROOT?.trim() || file.staticRoot || defaults?.staticRoot
  if (!staticCandidate) {
    throw new ServerConfigError('需要 staticRoot 或 JAVDEX_STATIC_ROOT')
  }
  const staticRoot = requireAbsolute('staticRoot', staticCandidate)
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
    throw new ServerConfigError('网页静态目录缺少 index.html，请先构建 Web 产物')
  }
  const listenHost = env.JAVDEX_LISTEN_HOST?.trim() || file.listenHost
  const port = env.JAVDEX_LISTEN_PORT ? Number(env.JAVDEX_LISTEN_PORT) : file.port
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ServerConfigError('端口必须是 1024–65535 的整数')
  }
  const accessHosts = env.JAVDEX_ACCESS_HOSTS
    ? env.JAVDEX_ACCESS_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
    : file.accessHosts
  if (accessHosts.length === 0) {
    throw new ServerConfigError('accessHosts 不能为空')
  }
  const username = env.JAVDEX_WEB_USERNAME?.trim() || file.web.username
  if (!USERNAME.test(username)) {
    throw new ServerConfigError('网页账号须为 1–64 个字母、数字、点、横线或下划线')
  }
  const passwordFromEnv = env.JAVDEX_WEB_PASSWORD
  let passwordHash = file.web.passwordHash
  if (passwordFromEnv) {
    passwordHash = await hashPassword(passwordFromEnv)
  }
  if (!passwordHash) {
    throw new ServerConfigError('需要 web.passwordHash 或环境变量 JAVDEX_WEB_PASSWORD')
  }
  const mediaMounts: Record<string, string> = {}
  for (const [name, mount] of Object.entries(file.mediaMounts)) {
    mediaMounts[name] = requireAbsolute(`mediaMounts.${name}`, mount)
  }
  if (path.relative(dataDir, imagesDir) === '' || imagesDir === dataDir) {
    throw new ServerConfigError('图片目录不能与数据目录相同')
  }
  return {
    command,
    config: {
      listenHost,
      port,
      accessHosts,
      dataDir,
      imagesDir,
      staticRoot,
      mediaMounts,
      web: { username, passwordHash }
    }
  }
}
