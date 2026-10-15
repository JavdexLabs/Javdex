import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { updaterPairingSchema } from '@shared/serverUpdateTypes'

export function assertConnectionStorage(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('安全凭据存储不可用，无法保存服务端连接')
}
export function readServerConnection(root: string, origin: string) {
  const file = path.join(root, 'server-update-secrets.bin')
  if (!fs.existsSync(file)) return undefined
  assertConnectionStorage()
  const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as { pairing: unknown; remoteBaseUrl: string; credentialKind?: 'device' }
  const pairing = updaterPairingSchema.parse(saved.pairing)
  if (new URL(origin).origin !== new URL(saved.remoteBaseUrl).origin || new URL(pairing.url).origin !== new URL(origin).origin) return undefined
  return { certificateSha256: pairing.certificateSha256,
    deviceIdentity: saved.credentialKind === 'device' ? { serverId: pairing.serverId, secret: pairing.token } : undefined }
}
export function readServerPin(root: string, origin: string): string | undefined { return readServerConnection(root, origin)?.certificateSha256 }
