export function playbackTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
