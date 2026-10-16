import type { IncomingMessage, ServerResponse } from 'node:http'
import { SERVER_ENVIRONMENT_VERSION, SERVER_RUNTIME_ID } from '@shared/serverEnvironment'

/** Read-only image metadata; never inspects the mutable program volume or DB. */
export function serveServerEnvironment(request: IncomingMessage, response: ServerResponse): boolean {
  if (new URL(request.url ?? '/', 'https://runtime.invalid').pathname !== '/runtime/v1/info') return false
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    response.writeHead(405)
    response.end(JSON.stringify({ code: 'METHOD_NOT_ALLOWED', error: '运行环境查询仅支持 GET' }))
    return true
  }
  const platform = `linux/${process.arch === 'x64' ? 'amd64' : process.arch}`
  if (platform !== 'linux/amd64' && platform !== 'linux/arm64') {
    response.writeHead(503)
    response.end(JSON.stringify({ code: 'UNSUPPORTED_PLATFORM', error: '不支持的容器平台' }))
    return true
  }
  response.writeHead(200)
  response.end(JSON.stringify({ format: 1, environmentVersion: SERVER_ENVIRONMENT_VERSION, runtimeId: SERVER_RUNTIME_ID, platform }))
  return true
}
