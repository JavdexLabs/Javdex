import { deserialize, serialize } from 'node:v8'
import type { Socket } from 'node:net'

export const SCRAPE_BROWSER_HELPER_FLAG = '--javdex-scraper-helper'
export const SCRAPE_BROWSER_PROTOCOL_VERSION = 1
export const SCRAPE_BROWSER_MAX_FRAME_BYTES = 32 * 1024 * 1024

export const SCRAPE_BROWSER_HELPER_ENV = {
  pipe: 'JAVDEX_SCRAPER_HELPER_PIPE',
  token: 'JAVDEX_SCRAPER_HELPER_TOKEN',
  profile: 'JAVDEX_SCRAPER_HELPER_PROFILE',
  cdpPort: 'JAVDEX_SCRAPER_HELPER_CDP_PORT',
  parentPid: 'JAVDEX_SCRAPER_HELPER_PARENT_PID'
} as const

export type ScrapeBrowserHelperCommand =
  | 'setProxy'
  | 'fetchPage'
  | 'fetchBuffer'
  | 'fetchBufferResponse'
  | 'performAction'
  | 'shutdown'

export interface ScrapeBrowserHelloFrame {
  type: 'hello'
  protocolVersion: typeof SCRAPE_BROWSER_PROTOCOL_VERSION
  token: string
  pid: number
  parentPid: number
  cdpPort: number
  targetId: string
}

export interface ScrapeBrowserRequestFrame {
  type: 'request'
  id: string
  command: ScrapeBrowserHelperCommand
  payload: Record<string, unknown>
}

export interface ScrapeBrowserResponseFrame {
  type: 'response'
  id: string
  ok: boolean
  value?: unknown
  error?: {
    name: string
    code?: string
    message: string
    url?: string
    title?: string
  }
}

export interface ScrapeBrowserCancelFrame {
  type: 'cancel'
  id: string
  reason?: string
}

export interface ScrapeBrowserEventFrame {
  type: 'event'
  event: 'fatal' | 'window-closed'
  message: string
}

export type ScrapeBrowserProtocolFrame =
  | ScrapeBrowserHelloFrame
  | ScrapeBrowserRequestFrame
  | ScrapeBrowserResponseFrame
  | ScrapeBrowserCancelFrame
  | ScrapeBrowserEventFrame

export function assertScrapeBrowserHello(
  frame: ScrapeBrowserHelloFrame,
  expected: { token: string; parentPid: number; cdpPort: number; childPid?: number }
): void {
  if (
    frame.protocolVersion !== SCRAPE_BROWSER_PROTOCOL_VERSION ||
    frame.token !== expected.token ||
    frame.parentPid !== expected.parentPid ||
    frame.cdpPort !== expected.cdpPort ||
    (expected.childPid !== undefined && frame.pid !== expected.childPid)
  ) {
    throw new Error('Scraper helper 握手认证失败')
  }
}

function assertFrameLength(length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0 || length > SCRAPE_BROWSER_MAX_FRAME_BYTES) {
    throw new Error(`Scrape browser IPC frame length is invalid: ${length}`)
  }
}

/** Length-prefixed V8 frames preserve Buffers without exposing an HTTP business endpoint. */
export class ScrapeBrowserFramedSocket {
  private buffered = Buffer.alloc(0)
  private disposed = false

  constructor(
    private readonly socket: Socket,
    private readonly onFrame: (frame: ScrapeBrowserProtocolFrame) => void,
    private readonly onError: (error: Error) => void
  ) {
    socket.on('data', (chunk: Buffer) => this.accept(chunk))
    socket.on('error', (error) => this.fail(error))
  }

  send(frame: ScrapeBrowserProtocolFrame): void {
    if (this.disposed || this.socket.destroyed) throw new Error('Scrape browser IPC is closed')
    const body = serialize(frame)
    assertFrameLength(body.length)
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(body.length, 0)
    this.socket.write(Buffer.concat([header, body]))
  }

  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.buffered = Buffer.alloc(0)
    this.socket.destroy()
  }

  private accept(chunk: Buffer): void {
    if (this.disposed) return
    this.buffered = this.buffered.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, chunk])
    try {
      while (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32BE(0)
        assertFrameLength(length)
        if (this.buffered.length < length + 4) return
        const body = this.buffered.subarray(4, length + 4)
        this.buffered = this.buffered.subarray(length + 4)
        const frame = deserialize(body) as ScrapeBrowserProtocolFrame
        if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
          throw new Error('Scrape browser IPC received an invalid frame')
        }
        this.onFrame(frame)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private fail(error: Error): void {
    if (this.disposed) return
    this.disposed = true
    this.buffered = Buffer.alloc(0)
    this.socket.destroy()
    this.onError(error)
  }
}
