import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readTestUserDataPath } from '@shared/appIdentity'
import type { ScraperServiceId } from '@shared/scraperServiceTypes'

interface SecretFile {
  version: 1
  entries: Partial<Record<ScraperServiceId, string>>
}

export interface ScraperServiceSecretCipher {
  state(): {
    protection: 'secure' | 'degraded' | 'unavailable'
    backend: string
  }
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

const EMPTY_SECRET_FILE: SecretFile = { version: 1, entries: {} }
let cache: SecretFile | null = null
let cipherOverride: ScraperServiceSecretCipher | null = null

function userDataPath(): string {
  const testPath = readTestUserDataPath()
  if (testPath) return testPath
  return app.getPath('userData')
}

function secretFilePath(): string {
  return path.join(userDataPath(), 'scraper-service-secrets.json')
}

function electronCipher(): ScraperServiceSecretCipher {
  return {
    state() {
      try {
        if (!safeStorage.isEncryptionAvailable()) {
          return { protection: 'unavailable', backend: 'unavailable' }
        }
        const backend = process.platform === 'linux'
          ? safeStorage.getSelectedStorageBackend()
          : process.platform === 'darwin'
            ? 'macOS Keychain'
            : 'Windows DPAPI'
        return {
          protection: backend === 'basic_text' ? 'degraded' : 'secure',
          backend
        }
      } catch {
        return { protection: 'unavailable', backend: 'unavailable' }
      }
    },
    encrypt(value): Buffer {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统没有可用的凭证存储后端')
      }
      return safeStorage.encryptString(value)
    },
    decrypt(value): string {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统没有可用的凭证存储后端')
      }
      return safeStorage.decryptString(value)
    }
  }
}

function activeCipher(): ScraperServiceSecretCipher {
  return cipherOverride ?? electronCipher()
}

function loadSecretFile(): SecretFile {
  if (cache) return cache
  let raw: string
  try {
    raw = fs.readFileSync(secretFilePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { ...EMPTY_SECRET_FILE, entries: {} }
      return cache
    }
    throw new Error(`读取刮削服务凭证失败：${(error as Error).message}`)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SecretFile>
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new Error('不支持的凭证文件格式')
    }
    cache = {
      version: 1,
      entries: typeof parsed.entries.metatube === 'string'
        ? { metatube: parsed.entries.metatube }
        : {}
    }
    return cache
  } catch (error) {
    throw new Error(`读取刮削服务凭证失败：${(error as Error).message}`)
  }
}

function persistSecretFile(next: SecretFile): void {
  const file = secretFilePath()
  const temporaryFile = `${file}.tmp-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporaryFile, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.renameSync(temporaryFile, file)
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  } catch (error) {
    try {
      fs.rmSync(temporaryFile, { force: true })
    } catch {
      // Preserve the original persistence error.
    }
    throw new Error(`保存刮削服务凭证失败：${(error as Error).message}`)
  }
  cache = next
}

export function getScraperServiceSecretStorageState(): ReturnType<ScraperServiceSecretCipher['state']> {
  return activeCipher().state()
}

export function getScraperServiceToken(serviceId: ScraperServiceId): string {
  const encrypted = loadSecretFile().entries[serviceId]
  if (!encrypted) return ''
  try {
    return activeCipher().decrypt(Buffer.from(encrypted, 'base64')).trim()
  } catch (error) {
    throw new Error(`读取 MetaTube 访问令牌失败：${(error as Error).message}`)
  }
}

export function hasScraperServiceToken(serviceId: ScraperServiceId): boolean {
  return Boolean(loadSecretFile().entries[serviceId])
}

export function saveScraperServiceToken(serviceId: ScraperServiceId, rawValue: string): void {
  const value = rawValue.trim()
  if (!value) throw new Error('访问令牌不能为空')
  const cipher = activeCipher()
  if (cipher.state().protection === 'unavailable') {
    throw new Error('当前系统没有可用的凭证存储后端')
  }
  const encrypted = cipher.encrypt(value)
  if (cipher.decrypt(encrypted) !== value) throw new Error('验证访问令牌加密结果失败')
  persistSecretFile({
    version: 1,
    entries: {
      ...loadSecretFile().entries,
      [serviceId]: encrypted.toString('base64')
    }
  })
}

export function deleteScraperServiceToken(serviceId: ScraperServiceId): void {
  const current = loadSecretFile()
  if (!current.entries[serviceId]) return
  const entries = { ...current.entries }
  delete entries[serviceId]
  persistSecretFile({ version: 1, entries })
}

/** Test-only: replace the operating-system cipher and clear the file cache. */
export function setScraperServiceSecretCipherForTests(
  cipher: ScraperServiceSecretCipher | null
): void {
  cipherOverride = cipher
  cache = null
}

/** Test-only: clear cached encrypted entries between isolated user-data roots. */
export function resetScraperServiceSecretStoreForTests(): void {
  cache = null
}
