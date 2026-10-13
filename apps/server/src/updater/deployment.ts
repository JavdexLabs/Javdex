import type { ServerUpdateManifest } from '@shared/serverUpdateTypes'

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
  estimatedBytes: number
  port: number
}
export interface DeploymentSnapshot {
  identity: DeploymentIdentity
  release: string
  roots: string[]
  configHash: string
}
export interface UpdateDeployment {
  inspect(options?: { measure?: boolean }): Promise<DeploymentSnapshot>
  prepare(manifest: ServerUpdateManifest, archive?: string): Promise<void>
  stop(): Promise<void>
  backup(jobDir: string, original: DeploymentSnapshot): Promise<void>
  install(manifest: ServerUpdateManifest, jobId: string, original: DeploymentSnapshot): Promise<void>
  verify(manifest: ServerUpdateManifest, original: DeploymentSnapshot): Promise<void>
  activate(jobId: string, manifest: ServerUpdateManifest, original: DeploymentSnapshot): Promise<void>
  restore(jobDir: string, original: DeploymentSnapshot): Promise<void>
  cleanup(original: DeploymentSnapshot): Promise<void>
}
