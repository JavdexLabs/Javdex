import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { updaterPairingSchema } from '@shared/serverUpdateTypes'
import type { DesktopCredentialStore } from '../application/desktopPorts'

export function assertConnectionStorage(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('安全凭据存储不可用，无法保存服务端连接')
}
interface ConnectionCipher {
  assertAvailable(): void
  decrypt(value: Buffer): string
}

/** One saved deployment connection, independent of the currently running session. */
export function createServerConnectionStore(root: string, cipher: ConnectionCipher = {
  assertAvailable: assertConnectionStorage,
  decrypt: value => safeStorage.decryptString(value)
}) {
  const file = path.join(root, 'server-update-secrets.bin')
  const read = () => {
    if (!fs.existsSync(file)) return null
    cipher.assertAvailable()
    const saved = JSON.parse(cipher.decrypt(fs.readFileSync(file))) as { pairing: unknown; remoteBaseUrl: string; credentialKind?: 'device' }
    if (saved.credentialKind !== 'device') return null
    const pairing = updaterPairingSchema.parse(saved.pairing)
    const remoteBaseUrl = new URL(saved.remoteBaseUrl).origin
    if (new URL(pairing.url).origin !== remoteBaseUrl) throw new Error('已保存的服务端连接身份不一致')
    return { pairing, remoteBaseUrl, credentialKind: saved.credentialKind }
  }
  return {
    read,
    async forget(credentials: Pick<DesktopCredentialStore, 'deleteWriterSecret'>): Promise<void> {
      const saved = read()
      if (saved?.credentialKind === 'device') await credentials.deleteWriterSecret(saved.pairing.catalogId)
      if (fs.existsSync(file)) fs.unlinkSync(file)
      const pending = path.join(root, 'server-connection-pending.bin')
      if (fs.existsSync(pending)) fs.unlinkSync(pending)
    }
  }
}
export function readServerConnection(root: string, origin: string) {
  const saved = createServerConnectionStore(root).read()
  if (!saved || new URL(origin).origin !== saved.remoteBaseUrl) return undefined
  const { pairing } = saved
  return { certificateSha256: pairing.certificateSha256,
    deviceIdentity: { serverId: pairing.serverId, secret: pairing.token } }
}
export function readServerPin(root: string, origin: string): string | undefined { return readServerConnection(root, origin)?.certificateSha256 }
