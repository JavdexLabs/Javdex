import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let cached: { key: Buffer; cert: Buffer } | undefined
/** Ephemeral certificate for isolated HTTPS fixtures; never used for a deployment. */
export function testTls(): { key: Buffer; cert: Buffer } {
  if (cached) return cached
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-test-tls-'))
  try {
    const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=JavdexTest', '-keyout', key, '-out', cert], { stdio: 'ignore' })
    cached = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
    return cached
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
