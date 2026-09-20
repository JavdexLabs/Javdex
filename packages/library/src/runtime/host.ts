import { readTestUserDataPath } from '@shared/appIdentity'

export interface LibraryImageSize {
  width: number
  height: number
}

export interface LibraryImageCodec {
  sizeFromBuffer(data: Uint8Array): LibraryImageSize | null
  sizeFromPath(filePath: string): LibraryImageSize | null
}

export interface LibraryAssetSettings {
  assetEncryption(): boolean
  mediaAssetsPath(): string | null
}

export interface LibraryHttpSettings {
  scrapeProxyUrl(): string
}

export interface LibraryHost {
  userDataPath(): string
  images?: LibraryImageCodec
  assets?: LibraryAssetSettings
  http?: LibraryHttpSettings
  mediaMounts?: () => Readonly<Record<string, string>>
}

let host: LibraryHost | null = null

export const AGENT_WORK_TABLES = [
  'agent_runs',
  'agent_resource_cleanup',
  'agent_operations',
  'agent_product_journal',
  'agent_execution_history',
  'agent_tool_ledger',
  'agent_approvals',
  'agent_artifacts',
  'agent_metadata_drafts',
  'agent_metadata_draft_resources'
] as const

export function configureLibraryHost(next: LibraryHost): void {
  host = next
}

export function resetLibraryHostForTests(): void {
  host = null
}

export function resolveLibraryUserDataPath(): string {
  const fromEnv = readTestUserDataPath()
  if (fromEnv) return fromEnv
  if (!host) throw new Error('Library host is not configured')
  return host.userDataPath()
}

export function getLibraryImageCodec(): LibraryImageCodec | undefined {
  return host?.images
}

export function resolveLibraryAssetEncryption(): boolean {
  return host?.assets?.assetEncryption() === true
}

export function resolveLibraryMediaAssetsPath(): string | null {
  const custom = host?.assets?.mediaAssetsPath()?.trim()
  return custom ? custom : null
}

export function resolveLibraryScrapeProxyUrl(): string {
  return host?.http?.scrapeProxyUrl()?.trim() ?? ''
}

export function resolveLibraryMediaMounts(): Record<string, string> {
  return { ...(host?.mediaMounts?.() ?? {}) }
}
