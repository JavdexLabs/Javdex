import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { BACKUP_CHUNK_BYTES } from '@shared/protocol/backup'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AssetReadQueueFullError, AssetReadTooLargeError, AssetPixelLimitError } from '@library/mediaAssetStore'
import { parseImageThumbnailSize, type ImageThumbnailSize } from '@shared/imageVariants'
import { MANAGE_OPERATIONS, type ManageOperationId } from '@shared/manage/operations'
import type { ManageErrorCode } from '@shared/protocol/errorCodes'
import { isStructuredError, structuredError, toStructuredError } from '@shared/protocol/errors'
import { JSON_REQUEST_MAX_BYTES } from '@shared/protocol/limits'
import { json, readJson, WebError } from './http'

const MANAGE_PREFIX = '/manage/v1/'
const APP_VERSION_HEADER = 'x-javdex-app-version'
const UPLOAD_PATH = /^\/manage\/v1\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const MIGRATION_PACKAGE_PATH =
  /^\/manage\/v1\/migration\/packages\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const ASSET_PREFIX = '/manage/v1/assets/'

export interface ManageHttpContext {
  operation: ManageOperationId
  body: unknown
  bearerSecret: string | null
  remoteAddress: string
  isLoopback: boolean
  host: string | null
}

export interface ManageUploadPutContext {
  uploadId: string
  request: IncomingMessage
  bearerSecret: string | null
  remoteAddress: string
  isLoopback: boolean
}

export interface ManageAssetGetContext {
  relPath: string
  size?: ImageThumbnailSize
  request: IncomingMessage
  bearerSecret: string | null
  remoteAddress: string
  isLoopback: boolean
  signal?: AbortSignal
}

export interface ManageMigrationPackagePutContext {
  migrationId: string
  request: IncomingMessage
  bearerSecret: string | null
  remoteAddress: string
  isLoopback: boolean
}

export interface ManageBackupFileContext {
  id: string
  offset: number
  request: IncomingMessage
  bearerSecret: string | null
}

export interface ManageHttpSurface {
  transferBackup?: (context: ManageBackupFileContext) => Promise<{ file?: string; offset?: number; release?: () => void }>
  appVersion: string
  dispatch: (context: ManageHttpContext) => unknown | Promise<unknown>
  putUpload?: (context: ManageUploadPutContext) => unknown | Promise<unknown>
  putMigrationPackage?: (context: ManageMigrationPackagePutContext) => unknown | Promise<unknown>
  getAsset?: (context: ManageAssetGetContext) => Promise<{ body: Buffer; mime: string }>
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
  const remoteAddress = request.socket.remoteAddress ?? ''
  const peer = {
    bearerSecret: bearerSecret(request),
    remoteAddress,
    isLoopback: isLoopbackPeer(remoteAddress)
  }
  const backupMatch = /^\/manage\/v1\/backups\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (backupMatch) {
    if (!manage.transferBackup) throw new WebError(404, '页面不存在')
    if (!['GET', 'PUT'].includes(request.method ?? '')) throw new WebError(405, '备份文件请使用 GET 或 PUT')
    if (!requireAppVersion(request, manage, response)) return true
    try {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw structuredError('INVALID_INPUT', '无效的备份偏移')
      const result = await manage.transferBackup({ id: backupMatch[1], offset, request, bearerSecret: peer.bearerSecret })
      try {
        if (result.file) {
          const total = fs.statSync(result.file).size
          if (offset >= total) throw structuredError('INVALID_INPUT', '下载偏移超过文件大小')
          const end = Math.min(total - 1, offset + BACKUP_CHUNK_BYTES - 1)
          response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - offset + 1), 'Content-Range': `bytes ${offset}-${end}/${total}`, 'Cache-Control': 'no-store' })
          await pipeline(fs.createReadStream(result.file, { start: offset, end }), response)
        } else json(response, 200, result)
      } finally { result.release?.() }
    } catch (error) {
      if (response.headersSent) response.destroy()
      else { const failure = toStructuredError(error); json(response, manageErrorStatus(failure.code), failure) }
    }
    return true
  }
  if (uploadMatch) {
    if ((request.method ?? '') !== 'PUT') throw new WebError(405, '上传内容请使用 PUT')
    if (!manage.putUpload) throw new WebError(404, '页面不存在')
    if (!requireAppVersion(request, manage, response)) return true
    await sendManageResult(response, () =>
      manage.putUpload!({
        uploadId: uploadMatch[1],
        request,
        ...peer
      })
    )
    return true
  }
  const packageMatch = MIGRATION_PACKAGE_PATH.exec(url.pathname)
  if (packageMatch) {
    if ((request.method ?? '') !== 'PUT') throw new WebError(405, '迁移包请使用 PUT')
    if (!manage.putMigrationPackage) throw new WebError(404, '页面不存在')
    if (!requireAppVersion(request, manage, response)) return true
    await sendManageResult(response, () =>
      manage.putMigrationPackage!({
        migrationId: packageMatch[1],
        request,
        ...peer
      })
    )
    return true
  }
  if (url.pathname.startsWith(ASSET_PREFIX)) {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') throw new WebError(405, '管理图片请使用 GET')
    if (!manage.getAsset) throw new WebError(404, '页面不存在')
    if (!requireAppVersion(request, manage, response)) return true
    let size: ImageThumbnailSize | undefined
    try {
      size = parseImageThumbnailSize(url.searchParams.get('size'))
    } catch {
      throw new WebError(400, '图片尺寸参数无效')
    }
    const relPath = decodeURIComponent(url.pathname.slice(ASSET_PREFIX.length))
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    response.once('close', abort)
    try {
      const image = await manage.getAsset({
        relPath,
        size,
        request,
        ...peer,
        signal: controller.signal
      })
      if (response.destroyed || controller.signal.aborted) return true
      response.setHeader('Content-Type', image.mime)
      response.setHeader('Content-Length', String(image.body.length))
      response.statusCode = 200
      response.end(method === 'HEAD' ? undefined : image.body)
    } catch (error) {
      if (response.destroyed || controller.signal.aborted) return true
      if (error instanceof AssetReadQueueFullError) throw new WebError(503, '图片读取繁忙，请稍后重试')
      if (error instanceof AssetReadTooLargeError || error instanceof AssetPixelLimitError) {
        throw new WebError(413, '图片过大')
      }
      const structured = isStructuredError(error) ? error : toStructuredError(error)
      json(response, manageErrorStatus(structured.code), structured)
    } finally {
      response.off('close', abort)
    }
    return true
  }
  if ((request.method ?? 'GET') !== 'POST') throw new WebError(405, '管理接口仅接受 POST')
  const operation = pathnameOperation(url.pathname)
  if (!operation) throw new WebError(404, '页面不存在')
  if (operation !== 'handshake.get' && !requireAppVersion(request, manage, response)) return true
  const body = await readJson(request, JSON_REQUEST_MAX_BYTES)
  await sendManageResult(response, () =>
    manage.dispatch({
      operation,
      body,
      ...peer,
      host: request.headers.host ?? null
    })
  )
  return true
}
