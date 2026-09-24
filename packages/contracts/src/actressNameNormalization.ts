/** Build the global ownership key for a searchable actress name. */
export function normalizeActressName(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .replace(/\p{White_Space}+/gu, '')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())

  if (!normalized) throw new Error('演员名称不能为空')
  return normalized
}
