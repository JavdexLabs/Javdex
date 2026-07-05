import { createRequire } from 'node:module'

type MusicMetadataApi = {
  parseFile(
    filePath: string,
    options?: { duration?: boolean }
  ): Promise<{ format: { duration?: number } }>
  loadMusicMetadata?: () => Promise<MusicMetadataApi>
}

let apiPromise: Promise<MusicMetadataApi> | null = null

async function getMusicMetadataApi(): Promise<MusicMetadataApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const mod = createRequire(import.meta.url)('music-metadata') as MusicMetadataApi
      if (typeof mod.parseFile === 'function') return mod
      if (typeof mod.loadMusicMetadata === 'function') return mod.loadMusicMetadata()
      throw new Error('music-metadata parseFile is unavailable')
    })()
  }
  return apiPromise
}

/** Convert configured minutes to seconds; null means duration filter disabled. */
export function resolveMinScanImportDurationSeconds(minutes: number): number | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return Math.round(minutes) * 60
}

export async function readLocalVideoDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { parseFile } = await getMusicMetadataApi()
    const metadata = await parseFile(filePath, { duration: true })
    const duration = metadata.format.duration
    if (duration == null || !Number.isFinite(duration) || duration <= 0) return null
    return Math.round(duration)
  } catch {
    return null
  }
}

export function isBelowMinImportDuration(
  durationSeconds: number | null,
  minSeconds: number
): boolean {
  return durationSeconds != null && durationSeconds < minSeconds
}

export interface ResolveVideoDisplayDurationInput {
  duration_seconds: number | null
  file_duration_seconds?: number | null
}

export interface VideoFileFingerprint {
  file_size: number | null
  file_mtime_ms: number | null
}

export interface StoredVideoFileProbeState {
  file_duration_seconds: number | null
  file_size: number | null
  file_mtime_ms: number | null
}

/** Whether scan should read container duration for this file row. */
export function shouldProbeVideoFileDuration(
  stored: StoredVideoFileProbeState,
  fingerprint: VideoFileFingerprint
): boolean {
  if (stored.file_duration_seconds == null || stored.file_duration_seconds <= 0) {
    return true
  }
  if (fingerprint.file_mtime_ms == null) return true
  if (stored.file_mtime_ms == null) {
    return stored.file_size !== fingerprint.file_size
  }
  return (
    stored.file_size !== fingerprint.file_size || stored.file_mtime_ms !== fingerprint.file_mtime_ms
  )
}

/** Whether a scan should persist a newly probed file duration. */
export function shouldRefreshVideoFileDuration(
  stored: number | null | undefined,
  probed: number | null
): boolean {
  if (probed == null || probed <= 0) return false
  if (stored == null || stored <= 0) return true
  return stored !== probed
}

/** Prefer scraped duration; otherwise use the primary file duration from DB. */
export function resolveVideoDisplayDurationSeconds(
  input: ResolveVideoDisplayDurationInput
): number | null {
  if (input.duration_seconds != null && input.duration_seconds > 0) {
    return input.duration_seconds
  }

  if (input.file_duration_seconds != null && input.file_duration_seconds > 0) {
    return input.file_duration_seconds
  }

  return null
}
