/** HTTP proxy authentication is separate from origin request headers. */
export function httpProxyOptions(proxy: URL): { uri: string; token?: string } {
  if (!proxy.username && !proxy.password) return { uri: proxy.origin }
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  return { uri: proxy.origin, token: `Basic ${Buffer.from(credentials).toString('base64')}` }
}
