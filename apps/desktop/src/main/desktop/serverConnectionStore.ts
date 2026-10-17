import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { updaterPairingSchema, type UpdaterPairing } from '@shared/serverUpdateTypes'
import type { DesktopCredentialStore } from '../application/desktopPorts'

export function assertConnectionStorage(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('安全凭据存储不可用，无法保存服务端连接')
}
interface ConnectionCipher {
  assertAvailable(): void
  decrypt(value: Buffer): string
  encrypt(value: string): Buffer
}
const legacyIdentitySchema = z.object({ origin: z.url(), serverId: z.uuid(), catalogId: z.uuid() }).strict()

/** One saved deployment connection, independent of the currently running session. */
export function createServerConnectionStore(root: string, cipher: ConnectionCipher = {
  assertAvailable: assertConnectionStorage,
  decrypt: value => safeStorage.decryptString(value),
  encrypt: value => safeStorage.encryptString(value)
}) {
  const file = path.join(root, 'server-update-secrets.bin')
  const legacyFile = path.join(root, 'server-legacy-identity.bin')
  const writeSecret = (destination: string, value: unknown): void => {
    cipher.assertAvailable()
    const encrypted = cipher.encrypt(JSON.stringify(value))
    fs.mkdirSync(root, { recursive: true })
    const temporary = `${destination}.tmp`
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 })
    fs.renameSync(temporary, destination)
  }
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
    readLegacyIdentity(address: string) {
      if (!fs.existsSync(legacyFile)) return undefined
      cipher.assertAvailable()
      const saved = legacyIdentitySchema.parse(JSON.parse(cipher.decrypt(fs.readFileSync(legacyFile))))
      const secure = new URL(saved.origin)
      const port = secure.port || '80'
      secure.protocol = 'https:'
      secure.port = port
      return [saved.origin, secure.origin].includes(new URL(address).origin) ? saved : undefined
    },
    rememberLegacyIdentity(address: string, identity: { serverId: string; catalogId: string }): void {
      const value = legacyIdentitySchema.parse({ origin: new URL(address).origin, serverId: identity.serverId, catalogId: identity.catalogId })
      writeSecret(legacyFile, value)
    },
    write(pairing: UpdaterPairing): void {
      const parsed = updaterPairingSchema.parse(pairing)
      writeSecret(file, { pairing: parsed, remoteBaseUrl: new URL(parsed.url).origin, credentialKind: 'device' })
      if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile)
    },
    async forget(credentials: Pick<DesktopCredentialStore, 'deleteWriterSecret'>): Promise<void> {
      const saved = read()
      if (saved?.credentialKind === 'device') await credentials.deleteWriterSecret(saved.pairing.catalogId)
      if (fs.existsSync(file)) fs.unlinkSync(file)
      if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile)
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
