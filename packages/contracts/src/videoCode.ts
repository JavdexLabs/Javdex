export function normalizeVideoCode(rawCode: string): string {
  const code = rawCode.trim().toUpperCase()
  if (!code) throw new Error('影片番号不能为空')
  return code
}
