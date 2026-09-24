import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { structuredError } from '@shared/protocol/errors'
import { readTestUserDataPath } from '@shared/appIdentity'
import type { DesktopCredentialStore } from '../application/desktopPorts'

interface WriterSecretFile {
  version: 1
  entries: Record<string, string>
}

export interface WriterSecretCipher {
  isAvailable(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

const EMPTY: WriterSecretFile = { version: 1, entries: {} }

function userDataPath(): string {
  const testPath = readTestUserDataPath()
  if (testPath) return testPath
  return app.getPath('userData')
}

function secretFilePath(root?: string): string {
  return path.join(root ?? userDataPath(), 'writer-secrets.json')
}

function electronCipher(): WriterSecretCipher {
  return {
    isAvailable(): boolean {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt(value): string {
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt(value): string {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
  }
}

export function createWriterCredentialStore(
  options: { userDataPath?: string; cipher?: WriterSecretCipher } = {}
): DesktopCredentialStore {
  const filePath = secretFilePath(options.userDataPath)
  const cipher = options.cipher ?? electronCipher()

  const load = (): WriterSecretFile => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WriterSecretFile>
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('writer secret file invalid')
      }
      return { version: 1, entries: parsed.entries }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, entries: {} }
      throw error
    }
  }

  const save = (file: WriterSecretFile): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temp = `${filePath}.tmp-${process.pid}`
    fs.writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 })
    fs.renameSync(temp, filePath)
  }

  const refuseInsecure = (): void => {
    throw structuredError('RECOVERY_REQUIRED', '安全凭据存储不可用，不能把 writer 秘密写入普通设置文件')
  }

  return {
    async isAvailable(): Promise<boolean> {
      return cipher.isAvailable()
    },
    async readWriterSecret(catalogId: string): Promise<string | null> {
      if (!cipher.isAvailable()) return null
      const entry = load().entries[catalogId]
      if (!entry) return null
      return cipher.decrypt(entry)
    },
    async writeWriterSecret(catalogId: string, secret: string): Promise<void> {
      if (!cipher.isAvailable()) refuseInsecure()
      const file = load()
      file.entries[catalogId] = cipher.encrypt(secret)
      save(file)
    },
    async deleteWriterSecret(catalogId: string): Promise<void> {
      if (!cipher.isAvailable()) return
      const file = load()
      if (!(catalogId in file.entries)) return
      delete file.entries[catalogId]
      save(file)
    }
  }
}
