/** Apply an origin-only referrer policy to browser resource requests. */
export function resolveFetchReferer(
  mode: 'omit' | 'session' | string | undefined,
  pageUrl: string | undefined,
  targetUrl: string
): string | null {
  if (mode === 'omit') return null
  const source = mode === undefined || mode === 'session' ? pageUrl : mode
  if (!source) return null
  try {
    const from = new URL(source)
    const to = new URL(targetUrl)
    if (!['http:', 'https:'].includes(from.protocol) || !['http:', 'https:'].includes(to.protocol)) return null
    if (from.protocol === 'https:' && to.protocol === 'http:') return null
    // Local services must not inherit a previous scraping website's origin.
    if (from.origin !== to.origin && isLocalHost(to.hostname)) return null
    return `${from.origin}/`
  } catch {
    return null
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return true
  if (host.includes(':')) return /^(?:f[cd]|fe[89ab])/.test(host) || host.startsWith('::ffff:')
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
