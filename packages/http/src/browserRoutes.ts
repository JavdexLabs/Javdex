/** The readonly Web surface, including its browser authentication endpoints. */
export const browserVideoRoute = /^\/api\/videos\/([1-9]\d{0,9})(?:\/(images|media)\/(cover|actress-[1-9]\d{0,9}|[1-9]\d{0,9}))?$/

export function isBrowserRequest(method: string, pathname: string): boolean {
  if (method === 'POST') return ['/api/login', '/api/logout', '/api/pair/start', '/api/pair/poll', '/api/pair/cancel', '/api/pair/status'].includes(pathname)
  if (method !== 'GET' && method !== 'HEAD') return false
  return ['/', '/index.html', '/api/session', '/api/collections', '/api/home', '/api/videos'].includes(pathname) ||
    /^\/assets\/[\w.-]+\.(js|css|png)$/.test(pathname) || browserVideoRoute.test(pathname)
}
