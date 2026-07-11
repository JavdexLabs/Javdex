type MetadataEvent = {
  tag?: { type?: string; id?: string; value?: unknown }
}

type ParseOptions = {
  duration?: boolean
  skipCovers?: boolean
  observer?: (event: MetadataEvent) => void
}

type Tokenizer = {
  close(): Promise<void>
}

type MusicMetadataApi = {
  parseFromTokenizer(
    tokenizer: Tokenizer,
    options?: ParseOptions
  ): Promise<{ format: { duration?: number } }>
}

type Strtok3Api = {
  fromFile(filePath: string): Promise<Tokenizer>
}

let apiPromise: Promise<MusicMetadataApi> | null = null
let strtok3Promise: Promise<Strtok3Api> | null = null

async function getMusicMetadataApi(): Promise<MusicMetadataApi> {
  if (!apiPromise) {
    apiPromise = import('music-metadata').then((mod) => {
      const api = mod as unknown as MusicMetadataApi
      if (typeof api.parseFromTokenizer !== 'function') {
        throw new Error('music-metadata parseFromTokenizer is unavailable')
      }
      return api
    })
  }
  return apiPromise
}

async function getStrtok3Api(): Promise<Strtok3Api> {
  if (!strtok3Promise) {
    strtok3Promise = import('strtok3').then((mod) => {
      const api = mod as unknown as Strtok3Api
      if (typeof api.fromFile !== 'function') {
        throw new Error('strtok3.fromFile is unavailable')
      }
      return api
    })
  }
  return strtok3Promise
}

function normalizeDurationSeconds(duration: unknown): number | null {
  const value = typeof duration === 'number' ? duration : Number(duration)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

/**
 * Read container duration. Stops as soon as format.duration is observed so MKV
 * files (e.g. SCR-078) do not keep scanning the whole Segment after Info.
 * Return contract is unchanged (number | null) so scan import/skip counts stay intact.
 */
export async function readLocalVideoDurationSeconds(filePath: string): Promise<number | null> {
  let observed: number | null = null
  let tokenizer: Tokenizer | null = null

  try {
    const [mm, strtok3] = await Promise.all([getMusicMetadataApi(), getStrtok3Api()])
    tokenizer = await strtok3.fromFile(filePath)

    let closePromise: Promise<void> | null = null
    const closeTokenizer = (): void => {
      if (!tokenizer || closePromise) return
      closePromise = tokenizer.close().catch(() => undefined)
    }

    try {
      const metadata = await mm.parseFromTokenizer(tokenizer, {
        duration: true,
        skipCovers: true,
        observer: (event) => {
          if (event.tag?.type !== 'format' || event.tag.id !== 'duration') return
          if (observed != null) return
          const seconds = normalizeDurationSeconds(event.tag.value)
          if (seconds == null) return
          observed = seconds
          // Closing the file handle aborts further Segment/Cluster reads.
          closeTokenizer()
        }
      })
      if (observed == null) {
        observed = normalizeDurationSeconds(metadata.format.duration)
      }
    } catch {
      // Early close surfaces as "file closed" / read errors; prefer observed duration.
    }

    return observed
  } catch {
    return observed
  } finally {
    if (tokenizer) {
      try {
        await tokenizer.close()
      } catch {
        /* already closed after early abort */
      }
    }
  }
}

/** Convert configured minutes to seconds; null means duration filter disabled. */
export function resolveMinScanImportDurationSeconds(minutes: number): number | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return Math.round(minutes) * 60
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
