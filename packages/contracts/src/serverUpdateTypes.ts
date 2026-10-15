import { z } from 'zod'

export const SERVER_UPDATE_PROTOCOL = 1
export const trustedDevicesSchema = z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(80), createdAt: z.string(), current: z.boolean() }).strict())
export const SERVER_RUNTIME_ID = 'node22-bookworm-v1'
export const SERVER_RELEASE_REQUIRED_FILES = ['index.js', 'webCatalogWorker.js', 'web/index.html', 'package.json', 'LICENSE', 'NOTICE', 'node_modules/better-sqlite3/package.json', 'node_modules/sharp/package.json'] as const
export function isServerReleasePath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.includes('\\') && !/[:\x00-\x1f]/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const platform = z.enum(['linux/amd64', 'linux/arm64'])
const releaseVersion = z.string().max(128)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/)
  .refine(value => value.slice(value.indexOf('-') + 1).split('.').every(part => !/^0\d+$/.test(part)), '预发布数字编号不能带前导零')
export const serverUpgradeVersionSchema = releaseVersion
export const releaseDescriptorSchema = z.object({
  format: z.literal(1), version: releaseVersion,
  build: z.string().regex(/^[a-f0-9]{40}$/), platform,
  runtime: z.literal(SERVER_RUNTIME_ID), targetSchema: z.number().int().positive(),
  files: z.record(z.string(), z.object({ bytes: z.number().int().nonnegative(), sha256: hash }).strict())
    .refine(files => Object.keys(files).length > 0 && Object.keys(files).length <= 20000)
}).strict()
export type ServerReleaseDescriptor = z.infer<typeof releaseDescriptorSchema>
export const updateManifestSchema = z.object({
  format: z.literal(1),
  version: releaseVersion,
  build: z.string().regex(/^[a-f0-9]{40}$/),
  expiresAt: z.iso.datetime(),
  platform,
  sourceSchemas: z.array(z.number().int().positive()).min(1),
  targetSchema: z.number().int().positive(),
  minUpdaterProtocol: z.literal(1), runtime: z.literal(SERVER_RUNTIME_ID),
  archive: z.object({
    url: z.url().refine(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && url.hostname === 'github.com' &&
        url.pathname.startsWith('/JavdexLabs/Javdex/releases/download/') && !url.username && !url.password
    }),
    bytes: z.number().int().positive().max(4 * 1024 ** 3),
    unpackedBytes: z.number().int().positive().max(8 * 1024 ** 3),
    sha256: hash
  }).strict()
}).strict()
export type ServerUpdateManifest = z.infer<typeof updateManifestSchema>
export const signedUpdateSchema = z.object({ keyId: z.string().regex(/^[\w-]{1,64}$/), payload: z.string().min(1).max(32768), signature: z.string().min(1).max(256) }).strict()
export type SignedServerUpdate = z.infer<typeof signedUpdateSchema>

export const updaterPairingSchema = z.object({
  protocolVersion: z.literal(1),
  url: z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  }),
  certificateSha256: hash,
  token: z.string().regex(/^[a-f0-9]{64}$/),
  serverId: z.uuid(),
  catalogId: z.uuid()
}).strict()
export type UpdaterPairing = z.infer<typeof updaterPairingSchema>

export const connectionClaimSchema = z.object({ code: z.string().regex(/^[a-f0-9]{64}$/),
  claimId: z.uuid(), secretDigest: hash, name: z.string().trim().min(1).max(80).optional(), appVersion: z.string().min(1).max(128) }).strict()

export const UPDATE_PHASES = ['preparing', 'prepared', 'stopping', 'installing', 'verifying', 'activating', 'complete', 'failed', 'recoveryRequired'] as const
export type ServerUpdatePhase = typeof UPDATE_PHASES[number]
export interface ServerUpdateJob {
  id: string
  version: string
  phase: ServerUpdatePhase
  receivedBytes: number
  totalBytes: number
  updatedAt: string
  message: string | null
  /** A paused offline transfer can be resumed by selecting the same signed file. */
  resumableUpload?: boolean
}
export interface ServerUpdateSnapshot {
  protocolVersion: 1
  paired: boolean
  serverId: string | null
  catalogId: string | null
  currentVersion: string | null
  platform: string | null
  runtime?: string | null
  targetVersion: string | null
  job: ServerUpdateJob | null
  devices?: import('./protocol/writer').TrustedDevice[]
  /** Saved local connection identity only; never includes certificates or credentials. */
  connection?: ServerConnectionSummary | null
  /** Local connection credentials changed since this desktop process started. */
  connectionRestartRequired?: boolean
}
export interface ServerConnectionSummary {
  remoteBaseUrl: string
  serverId: string
  catalogId: string
}
export const serverUpdateCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('connectionStatus') }).strict(),
  z.object({ action: z.literal('forgetConnection') }).strict(),
  z.object({ action: z.literal('connect'), remoteBaseUrl: updaterPairingSchema.shape.url, oneTimeToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('devices') }).strict(),
  z.object({ action: z.literal('revokeDevice'), deviceId: z.uuid() }).strict(),
  z.object({ action: z.literal('check'), targetVersion: releaseVersion }).strict(),
  z.object({ action: z.literal('import'), targetVersion: releaseVersion }).strict(),
  z.object({ action: z.literal('prepare'), targetVersion: releaseVersion }).strict(),
  z.object({ action: z.literal('install'), jobId: z.uuid(), targetVersion: releaseVersion }).strict()
])
export type ServerUpdateCommand = z.infer<typeof serverUpdateCommandSchema>
