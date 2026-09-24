import { isStructuredError, structuredError, toStructuredError, type StructuredError } from '@shared/protocol/errors'

const APP_VERSION_HEADER = 'X-Javdex-App-Version'

export interface ManageHttpClientOptions {
  baseUrl: string
  appVersion: string
  timeoutMs?: number
}

export interface ManageHttpCallOptions {
  bearer?: string | null
  signal?: AbortSignal
  sendAppVersion?: boolean
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathname}`
}

function throwIfStructured(status: number, body: unknown): void {
  if (isStructuredError(body)) throw body
  if (status >= 200 && status < 300) return
  if (status === 401 || status === 403) {
    throw structuredError('AUTH_REQUIRED', '管理接口鉴权失败')
  }
  throw structuredError('CONNECTION_UNAVAILABLE', '管理接口暂时不可用')
}

function networkError(error: unknown): StructuredError {
  if (isStructuredError(error)) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return structuredError('CONNECTION_UNAVAILABLE', '管理请求已取消或超时')
  }
  return structuredError('CONNECTION_UNAVAILABLE', '无法连接远程资料库')
}

export class ManageHttpClient {
  readonly origin: string
  readonly baseUrl: string
  readonly appVersion: string
  readonly timeoutMs: number

  constructor(options: ManageHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.origin = new URL(this.baseUrl).origin
    this.appVersion = options.appVersion
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async post(
    operation: string,
    body: unknown,
    options: ManageHttpCallOptions = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Origin: this.origin,
      'Content-Type': 'application/json'
    }
    if (options.sendAppVersion !== false && operation !== 'handshake.get') {
      headers[APP_VERSION_HEADER] = this.appVersion
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
    try {
      const response = await fetch(joinUrl(this.baseUrl, `/manage/v1/${operation}`), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs)
      })
      const json: unknown = await response.json().catch(() => null)
      throwIfStructured(response.status, json)
      return json
    } catch (error) {
      throw networkError(error)
    }
  }

  async putUpload(
    uploadId: string,
    body: Buffer,
    contentType: string,
    options: ManageHttpCallOptions = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Origin: this.origin,
      'Content-Type': contentType,
      [APP_VERSION_HEADER]: this.appVersion
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
    try {
      const response = await fetch(joinUrl(this.baseUrl, `/manage/v1/uploads/${uploadId}`), {
        method: 'PUT',
        headers,
        body: new Uint8Array(body),
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs)
      })
      const json: unknown = await response.json().catch(() => null)
      throwIfStructured(response.status, json)
      return json
    } catch (error) {
      throw networkError(error)
    }
  }

  async putMigrationPackage(
    migrationId: string,
    body: Buffer,
    options: ManageHttpCallOptions = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Origin: this.origin,
      'Content-Type': 'application/octet-stream',
      [APP_VERSION_HEADER]: this.appVersion
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
    try {
      const response = await fetch(joinUrl(this.baseUrl, `/manage/v1/migration/packages/${migrationId}`), {
        method: 'PUT',
        headers,
        body: new Uint8Array(body),
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs)
      })
      const json: unknown = await response.json().catch(() => null)
      throwIfStructured(response.status, json)
      return json
    } catch (error) {
      throw networkError(error)
    }
  }

  async getAsset(
    relPath: string,
    options: ManageHttpCallOptions & { size?: number } = {}
  ): Promise<{ body: Buffer; mime: string }> {
    const headers: Record<string, string> = {
      Origin: this.origin,
      [APP_VERSION_HEADER]: this.appVersion
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
    const encoded = relPath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const search = options.size ? `?size=${options.size}` : ''
    try {
      const response = await fetch(joinUrl(this.baseUrl, `/manage/v1/assets/${encoded}${search}`), {
        method: 'GET',
        headers,
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs)
      })
      if (response.status >= 400) {
        const json: unknown = await response.json().catch(() => null)
        throwIfStructured(response.status, json)
      }
      const mime = response.headers.get('content-type') ?? 'application/octet-stream'
      const body = Buffer.from(await response.arrayBuffer())
      return { body, mime }
    } catch (error) {
      throw networkError(error)
    }
  }
}

export function asStructuredManageError(error: unknown): StructuredError {
  return isStructuredError(error) ? error : toStructuredError(error)
}
