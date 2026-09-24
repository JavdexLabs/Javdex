export function normalizeRelatedLinkUrl(raw: string): string {
  const parsed = new URL(raw.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('相关链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (parsed.username || parsed.password) {
    throw new Error('相关链接必须是不含凭据的 HTTP/HTTPS 地址')
  }
  parsed.hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./u, '')
  parsed.hash = ''
  return parsed.toString()
}
