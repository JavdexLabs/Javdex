export function playbackTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

/** Seconds, mm:ss or hh:mm:ss; reject ambiguous/overflowing clock fields. */
export function parsePlaybackTime(input: string): number | null {
  const value = input.trim()
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(value)) return null
  const parts = value.split(':').map(Number)
  if (parts.slice(1).some(part => part >= 60)) return null
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Number.isSafeInteger(seconds) && seconds <= 604800 ? seconds : null
}
