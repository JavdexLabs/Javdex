/** Shared by candidate previews and the local file, so the two stay comparable. */
export function formatMinutes(seconds: number | null | undefined): string | null {
  if (seconds == null) return null
  return `${Math.round(seconds / 60)} 分钟`
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}
