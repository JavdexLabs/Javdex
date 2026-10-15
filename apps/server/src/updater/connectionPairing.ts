import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import { connectionClaimSchema } from '@shared/serverUpdateTypes'
import { readJsonIfExists, writeJsonAtomic } from './files'

const issuedSchema = z.object({ kind: z.enum(['initialBind', 'deployRecover', 'deviceAdd']), oneTimeToken: z.string().min(1),
  expiresAt: z.string(), serverId: z.uuid(), catalogId: z.uuid() })
const stateSchema = z.object({ digest: z.string(), issued: issuedSchema, expiresAt: z.number(),
  candidate: connectionClaimSchema.omit({ code: true }).nullable() })
/** One active deployment-issued grant. Consumed candidate survives a lost response. */
export class ConnectionPairing {
  private readonly file: string
  private busy = false
  constructor(directory: string, private readonly now = Date.now) { this.file = path.join(directory, 'connection-grant.json') }
  issue(value: unknown): { code: string; expiresAt: string; serverId: string; catalogId: string } {
    const issued = issuedSchema.parse(value)
    const expiresAt = Math.min(Date.parse(issued.expiresAt), this.now() + 10 * 60_000)
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('写入授权已过期')
    const code = randomBytes(32).toString('hex')
    writeJsonAtomic(this.file, { digest: this.digest(code), issued, expiresAt, candidate: null })
    return { code, expiresAt: new Date(expiresAt).toISOString(), serverId: issued.serverId, catalogId: issued.catalogId }
  }
  async claim<T>(input: unknown, consume: (issued: z.infer<typeof issuedSchema>, candidate: { claimId: string; secretDigest: string; name?: string }) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('配对正在处理，请稍后重试')
    this.busy = true
    try {
      const { code, ...candidate } = connectionClaimSchema.parse(input)
      const grant = stateSchema.parse(readJsonIfExists(this.file))
      if (this.digest(code) !== grant.digest) throw new Error('配对信息无效')
      if (grant.candidate) {
        if (grant.candidate.claimId !== candidate.claimId || grant.candidate.secretDigest !== candidate.secretDigest) throw new Error('配对信息已被另一台客户端使用')
      } else if (this.now() >= grant.expiresAt) throw new Error('配对信息已过期，请重新生成')
      // Persist the candidate BEFORE touching the independent writer transaction.
      writeJsonAtomic(this.file, { ...grant, candidate })
      // appVersion belongs to the connection claim, not the strict writer candidate.
      return await consume(grant.issued, {
        claimId: candidate.claimId, secretDigest: candidate.secretDigest,
        ...(candidate.name === undefined ? {} : { name: candidate.name })
      })
    } finally { this.busy = false }
  }
  private digest(code: string): string { return createHash('sha256').update(code).digest('hex') }
}
