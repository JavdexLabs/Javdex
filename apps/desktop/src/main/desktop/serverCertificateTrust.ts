import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, safeStorage } from 'electron'
import { assertConnectionStorage, createServerConnectionStore } from './serverConnectionStore'
import { assertRemoteBaseUrl } from './remoteConnectionUrl'
import type { VerifyServerCertificate } from '@http/pinnedFetch'

type ConfirmChange = (origin: string, previous: string, current: string) => Promise<boolean>
interface CertificateCipher {
  assertAvailable(): void
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
const pending = new Map<string, { fingerprint: string; promise: Promise<void> }>()
const fingerprintPattern = /^[a-f0-9]{64}$/

async function confirmCertificateChange(origin: string, previous: string, current: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning', title: '服务器证书已变化', message: `${origin} 的证书与此前保存的证书不同。`,
    detail: `如果管理员已更换服务器证书，可确认信任新证书后继续连接。\n\n原证书 SHA-256：\n${previous}\n\n新证书 SHA-256：\n${current}`,
    buttons: ['取消连接', '信任新证书'], defaultId: 0, cancelId: 0, noLink: true
  }
  const window = BrowserWindow.getFocusedWindow()
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

/** First use and valid public certificates are automatic; changed self-signed pins require consent. */
export function createServerCertificateTrust(root: string, address: string, confirm: ConfirmChange = confirmCertificateChange, cipher: CertificateCipher = {
  assertAvailable: assertConnectionStorage,
  encrypt: value => safeStorage.encryptString(value),
  decrypt: value => safeStorage.decryptString(value)
}): VerifyServerCertificate {
  assertRemoteBaseUrl(address)
  const origin = new URL(address).origin
  const file = path.join(root, 'server-certificates.bin')
  const key = `${root}\0${origin}`
  return (fingerprint, publiclyTrusted) => {
    const active = pending.get(key)
    if (active?.fingerprint === fingerprint) return active.promise
    const before = active?.promise ?? Promise.resolve()
    const task = before.catch(() => {}).then(async () => {
      if (!fingerprintPattern.test(fingerprint)) throw new Error('服务器证书指纹无效')
      cipher.assertAvailable()
      const pins = fs.existsSync(file) ? JSON.parse(cipher.decrypt(fs.readFileSync(file))) as Record<string, string> : {}
      if (!pins || typeof pins !== 'object' || Array.isArray(pins) || Object.values(pins).some(value => typeof value !== 'string' || !fingerprintPattern.test(value))) throw new Error('已保存的证书记录无效，请保留现场并检查本机安全存储')
      const saved = pins[origin] ? null : createServerConnectionStore(root, cipher).read()
      const previous = pins[origin] ?? (saved?.remoteBaseUrl === origin ? saved.pairing.certificateSha256 : undefined)
      if (!publiclyTrusted && previous && previous !== fingerprint && !await confirm(origin, previous, fingerprint)) {
        throw Object.assign(new Error('服务器证书已变化，已取消连接；确认信任新证书后才能继续'), { code: 'JAVDEX_CERTIFICATE_MISMATCH' })
      }
      if (pins[origin] !== fingerprint) {
        // Re-read to retain certificates concurrently accepted for other origins.
        const latest = fs.existsSync(file) ? JSON.parse(cipher.decrypt(fs.readFileSync(file))) as Record<string, string> : {}
        fs.mkdirSync(root, { recursive: true })
        const temporary = `${file}.tmp`
        fs.writeFileSync(temporary, cipher.encrypt(JSON.stringify({ ...latest, [origin]: fingerprint })), { mode: 0o600 })
        fs.renameSync(temporary, file)
      }
    })
    pending.set(key, { fingerprint, promise: task })
    void task.finally(() => { if (pending.get(key)?.promise === task) pending.delete(key) }).catch(() => {})
    return task
  }
}
