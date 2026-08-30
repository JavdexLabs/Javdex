import { app, safeStorage } from 'electron'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import type { ModelRole } from '@shared/aiConfigurationTypes'

let testKey: Buffer | null = null
let cachedKey: Buffer | null = null

function keyFilePath(): string {
  return path.join(readTestUserDataPath() ?? app.getPath('userData'), 'agent-cache-key.bin')
}

function loadOrCreateDeviceKey(): Buffer {
  if (testKey) return testKey
  if (cachedKey) return cachedKey
  const target = keyFilePath()
  try {
    const encrypted = fs.readFileSync(target)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('安全凭据设施不可用')
    const decoded = Buffer.from(safeStorage.decryptString(encrypted), 'base64')
    if (decoded.length !== 32) throw new Error('device cache key 长度无效')
    cachedKey = decoded
    return decoded
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`读取 Agent cache key 失败：${(error as Error).message}`)
    }
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('无法安全创建 Agent cache key')
  const key = randomBytes(32)
  const encrypted = safeStorage.encryptString(key.toString('base64'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, encrypted, { mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600)
  cachedKey = key
  return key
}

export function createCacheAffinityId(
  runId: string,
  modelRole: ModelRole,
  routeRevision: string
): string {
  const input = ['v1', runId, modelRole, routeRevision].join('\0')
  return `jvx_${createHmac('sha256', loadOrCreateDeviceKey()).update(input).digest('base64url')}`
}

export function setCacheAffinityDeviceKeyForTests(key: Buffer | null): void {
  testKey = key
  cachedKey = null
}
