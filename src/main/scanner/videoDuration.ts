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
