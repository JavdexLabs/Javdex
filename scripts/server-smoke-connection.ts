import { createHash, randomUUID } from 'node:crypto'
import { createPinnedFetch } from '../packages/http/src/pinnedFetch'

/** Scoped TLS transport for an isolated smoke container's single public origin. */
export function smokeConnection(origin: string) {
  let pin: string | undefined
  const transport = createPinnedFetch(origin, undefined, { verifyCertificate: async fingerprint => {
    if (pin && pin !== fingerprint) throw new Error('Isolated smoke certificate changed')
    pin = fingerprint
  } })
  return {
    get certificateSha256() { return pin },
    fetch: (url: string | URL, init: RequestInit = {}) => transport.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) }),
    async claim(oneTimeToken: string, appVersion: string, secret: string) {
      if (!/^[a-f0-9]{64}$/.test(oneTimeToken)) throw new Error('Invalid smoke token')
      const response = await transport.fetch(new URL('/connect/v1/claim', origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ code: oneTimeToken, claimId: randomUUID(), secretDigest: createHash('sha256').update(secret).digest('hex'), name: 'Isolated smoke', appVersion })
      })
      const result = await response.json()
      if (!response.ok) throw new Error(`Unified smoke pairing failed (${response.status}): ${JSON.stringify(result)}`)
      return result as object
    },
    close: () => transport.close()
  }
}
