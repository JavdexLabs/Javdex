import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readTestUserDataPath } from '@shared/appIdentity'
import type { LlmSecretStorageState } from '@shared/settingsTypes'

interface SecretFile {
  version: 1
  entries: Record<string, string>
}

export interface LlmSecretCipher {
  state(): Omit<LlmSecretStorageState, 'migrationError'>
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

const EMPTY_SECRET_FILE: SecretFile = { version: 1, entries: {} }
let cache: SecretFile | null = null
let cipherOverride: LlmSecretCipher | null = null

function userDataPath(): string {
  const testPath = readTestUserDataPath()
  if (testPath) return testPath
  return app.getPath('userData')
}

function secretFilePath(): string {
  return path.join(userDataPath(), 'llm-secrets.json')
}

function electronCipher(): LlmSecretCipher {
  return {
    state(): Omit<LlmSecretStorageState, 'migrationError'> {
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

function activeCipher(): LlmSecretCipher {
  return cipherOverride ?? electronCipher()
}

function loadSecretFile(): SecretFile {
  if (cache) return cache
  const file = secretFilePath()
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { ...EMPTY_SECRET_FILE, entries: {} }
      return cache
    }
    throw new Error(`读取 LLM 密钥失败：${(error as Error).message}`)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SecretFile>
    if (
      parsed.version !== 1 ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)
    ) {
      throw new Error('不支持的密钥文件格式')
    }
    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter(
        (entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === 'string'
      )
    )
    cache = { version: 1, entries }
    return cache
  } catch (error) {
    throw new Error(`读取 LLM 密钥失败：${(error as Error).message}`)
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
    throw new Error(`保存 LLM 密钥失败：${(error as Error).message}`)
  }
  cache = next
}

export function getLlmSecretStorageState(): Omit<LlmSecretStorageState, 'migrationError'> {
  return activeCipher().state()
}

export function getLlmApiKey(providerId: string): string {
  const encrypted = loadSecretFile().entries[providerId.trim()]
  if (!encrypted) return ''
  try {
    return activeCipher().decrypt(Buffer.from(encrypted, 'base64')).trim()
  } catch (error) {
    throw new Error(`读取「${providerId}」的 API Key 失败：${(error as Error).message}`)
  }
}

export function hasLlmApiKey(providerId: string): boolean {
  return Boolean(loadSecretFile().entries[providerId.trim()])
}

export function saveLlmApiKeys(values: Record<string, string>): void {
  const current = loadSecretFile()
  const nextEntries = { ...current.entries }
  const cipher = activeCipher()
  for (const [rawProviderId, rawValue] of Object.entries(values)) {
    const providerId = rawProviderId.trim()
    const value = rawValue.trim()
    if (!providerId || !value) continue
    const encrypted = cipher.encrypt(value)
    if (cipher.decrypt(encrypted) !== value) {
      throw new Error(`验证「${providerId}」的加密结果失败`)
    }
    nextEntries[providerId] = encrypted.toString('base64')
  }
  persistSecretFile({ version: 1, entries: nextEntries })
}

export function deleteLlmApiKey(providerId: string): void {
  const current = loadSecretFile()
  const id = providerId.trim()
  if (!id || !current.entries[id]) return
  const nextEntries = { ...current.entries }
  delete nextEntries[id]
  persistSecretFile({ version: 1, entries: nextEntries })
}

/** Test-only: replace the operating-system cipher and clear the file cache. */
export function setLlmSecretCipherForTests(cipher: LlmSecretCipher | null): void {
  cipherOverride = cipher
  cache = null
}

/** Test-only: clear cached encrypted entries between isolated user-data roots. */
export function resetLlmSecretStoreForTests(): void {
  cache = null
}
