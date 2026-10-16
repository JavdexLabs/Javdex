import type { ServerUpdateManifest } from '@shared/serverUpdateTypes'

// Installation needs a verified release identity, not a download URL or signature.
// Image releases enter only through the manager's local startup path.
export type DeploymentRelease = Pick<ServerUpdateManifest, 'version' | 'build' | 'platform' | 'runtime' | 'targetSchema' | 'sourceSchemas'> & {
  /** Optional only when reading already committed historical local journals. */
  environmentVersion?: number
  archive: { sha256: string }
}

export interface DeploymentIdentity {
  version: string
  schema: number
  platform: string
  runtime: string
  serverId: string
  catalogId: string
  dataDir: string
  imagesDir: string
  busy: boolean
  port: number
}
export interface DeploymentSnapshot {
  identity: DeploymentIdentity
  release: string
  roots: string[]
  configHash: string
}
export interface UpdateDeployment {
  inspect(): Promise<DeploymentSnapshot>
  prepare(manifest: ServerUpdateManifest, archive?: string): Promise<void>
  stop(): Promise<void>
  install(manifest: DeploymentRelease, jobId: string, original: DeploymentSnapshot): Promise<void>
  verify(manifest: DeploymentRelease, original: DeploymentSnapshot): Promise<void>
  activate(jobId: string, manifest: DeploymentRelease, original: DeploymentSnapshot): Promise<void>
  resume(original: DeploymentSnapshot): Promise<void>
  cleanup(original: DeploymentSnapshot): Promise<void>
}
