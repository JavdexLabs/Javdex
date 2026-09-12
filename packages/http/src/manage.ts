import type { IncomingMessage, ServerResponse } from 'node:http'
import { MANAGE_OPERATIONS, type ManageOperationId } from '@shared/manage/operations'
import type { ManageErrorCode } from '@shared/protocol/errorCodes'
import { isStructuredError, structuredError, toStructuredError } from '@shared/protocol/errors'
import { JSON_REQUEST_MAX_BYTES } from '@shared/protocol/limits'
import { json, readJson, WebError } from './http'

const MANAGE_PREFIX = '/manage/v1/'
const APP_VERSION_HEADER = 'x-javdex-app-version'
const UPLOAD_PATH = /^\/manage\/v1\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export interface ManageHttpContext {
  operation: ManageOperationId
  body: unknown
  bearerSecret: string | null
  remoteAddress: string
  isLoopback: boolean
}

export interface ManageUploadPutContext {
  uploadId: string
  request: IncomingMessage
  bearerSecret: string | null
  remoteAddress: string
  isLoopback: boolean
}

export interface ManageHttpSurface {
  appVersion: string
  dispatch: (context: ManageHttpContext) => unknown | Promise<unknown>
  putUpload?: (context: ManageUploadPutContext) => unknown | Promise<unknown>
}

export function isLoopbackPeer(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1'
}

export function isManageOperationId(value: string): value is ManageOperationId {
  return Object.prototype.hasOwnProperty.call(MANAGE_OPERATIONS, value)
}

export function manageErrorStatus(code: ManageErrorCode): number {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'BROWSER_AUTH_REJECTED':
      return 401
    case 'CATALOG_FROZEN':
      return 403
    case 'INVALID_INPUT':
    case 'LIMIT_EXCEEDED':
      return 400
    case 'UNSUPPORTED_CAPABILITY':
      return 501
    case 'CONNECTION_UNAVAILABLE':
    case 'MODE_PREP_REQUIRED':
      return 503
    default:
      return 409
  }
}

function bearerSecret(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer ([^ ]+)$/.exec(header)
  return match?.[1] ?? null
}

function pathnameOperation(pathname: string): ManageOperationId | null {
  if (!pathname.startsWith(MANAGE_PREFIX)) return null
  const operation = decodeURIComponent(pathname.slice(MANAGE_PREFIX.length))
  if (!operation || operation.includes('/') || !isManageOperationId(operation)) return null
  return operation
}

function requireAppVersion(
  request: IncomingMessage,
  manage: ManageHttpSurface,
  response: ServerResponse
): boolean {
  const header = request.headers[APP_VERSION_HEADER]
  const appVersion = Array.isArray(header) ? header[0] : header
  if (appVersion !== manage.appVersion) {
    json(
      response,
      manageErrorStatus('VERSION_MISMATCH'),
      structuredError('VERSION_MISMATCH', '桌面与服务器应用版本不一致')
    )
    return false
  }
  return true
}

async function sendManageResult(
  response: ServerResponse,
  work: () => unknown | Promise<unknown>
): Promise<void> {
  try {
    const result = await work()
    json(response, 200, result)
  } catch (error) {
    const structured = isStructuredError(error) ? error : toStructuredError(error)
    json(response, manageErrorStatus(structured.code), structured)
  }
}

/** Browser session cookies are ignored; callers must not pass them into dispatch. */
export async function handleManageHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  manage: ManageHttpSurface | undefined,
  originOk: boolean
): Promise<boolean> {
  if (!url.pathname.startsWith(MANAGE_PREFIX)) return false
  if (!manage) throw new WebError(404, '页面不存在')
  if (request.headers.origin && !originOk) throw new WebError(403, '不允许跨站请求')
  const uploadMatch = UPLOAD_PATH.exec(url.pathname)
  if (uploadMatch) {
    if ((request.method ?? '') !== 'PUT') throw new WebError(405, '上传内容请使用 PUT')
    if (!manage.putUpload) throw new WebError(404, '页面不存在')
    if (!requireAppVersion(request, manage, response)) return true
    const remoteAddress = request.socket.remoteAddress ?? ''
    await sendManageResult(response, () =>
      manage.putUpload!({
        uploadId: uploadMatch[1],
        request,
        bearerSecret: bearerSecret(request),
        remoteAddress,
        isLoopback: isLoopbackPeer(remoteAddress)
      })
    )
    return true
  }
  if ((request.method ?? 'GET') !== 'POST') throw new WebError(405, '管理接口仅接受 POST')
  const operation = pathnameOperation(url.pathname)
  if (!operation) throw new WebError(404, '页面不存在')
  if (operation !== 'handshake.get' && !requireAppVersion(request, manage, response)) return true
  const body = await readJson(request, JSON_REQUEST_MAX_BYTES)
  const remoteAddress = request.socket.remoteAddress ?? ''
  await sendManageResult(response, () =>
    manage.dispatch({
      operation,
      body,
      bearerSecret: bearerSecret(request),
      remoteAddress,
      isLoopback: isLoopbackPeer(remoteAddress)
    })
  )
  return true
}
