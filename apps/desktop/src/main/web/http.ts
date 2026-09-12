import type { IncomingMessage, ServerResponse } from 'node:http'
import { open, type FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

export class WebError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
export function json(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify(value))
}
export async function readJson(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new WebError(415, '请使用 JSON 请求')
  request.setEncoding('utf8')
  let body = ''
  for await (const chunk of request) {
    body += chunk.toString()
    if (Buffer.byteLength(body) > 4096) throw new WebError(413, '请求过大')
  }
  try {
    const value: unknown = JSON.parse(body)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new WebError(400, '请求格式无效')
  }
}

export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0)
    throw new WebError(416, '无效的播放范围')
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]))
  const end = match[1]
    ? match[2]
      ? Math.min(Number(match[2]), size - 1)
      : size - 1
    : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new WebError(416, '无效的播放范围')
  return { start, end }
}

/** Stream from a verified open descriptor, never buffer a video in memory. */
export async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  mime: string,
  expected?: { dev: number; ino: number; size: number; mtimeMs: number }
): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      (expected &&
        (stat.dev !== expected.dev ||
          stat.ino !== expected.ino ||
          stat.size !== expected.size ||
          stat.mtimeMs !== expected.mtimeMs))
    )
      throw new WebError(404, '资源已变化或不可用')
    response.setHeader('Accept-Ranges', 'bytes')
    let range: ReturnType<typeof parseRange>
    try {
      range = parseRange(request.headers.range, stat.size)
    } catch (error) {
      response.setHeader('Content-Range', `bytes */${stat.size}`)
      throw error
    }
    response.setHeader('Content-Type', mime)
    response.setHeader(
      'Content-Length',
      range ? range.end - range.start + 1 : stat.size
    )
    if (range)
      response.setHeader(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${stat.size}`
      )
    response.statusCode = range ? 206 : 200
    if (request.method === 'HEAD' || stat.size === 0) {
      response.end()
      return
    }
    const stream = handle.createReadStream({
      ...(range ?? {}),
      autoClose: false
    })
    await pipeline(stream, response)
  } finally {
    await handle?.close()
  }
}

export const VIDEO_MIMES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska'
}
