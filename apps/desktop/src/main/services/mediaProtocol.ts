import path from 'node:path'
import { parseImageThumbnailSize, type ImageThumbnailSize } from '@shared/imageVariants'
import { AssetReadQueueFullError, AssetReadTooLargeError, AssetPixelLimitError } from '@library/mediaAssetStore'

interface AssetReader {
  rootPath(): string
  readForServeAsync(relPath: string, signal?: AbortSignal, size?: ImageThumbnailSize): Promise<{ body: Buffer; mime: string }>
}

export async function serveMediaAssetRequest(request: Request, reader: AssetReader): Promise<Response> {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  try {
    const root = reader.rootPath()
    const abs = resolveMediaAssetPath(request.url, root)
    if (!abs) return new Response(request.method === 'HEAD' ? null : 'Forbidden', { status: 403, headers })
    let size: ImageThumbnailSize | undefined
    try { size = parseImageThumbnailSize(new URL(request.url).searchParams.get('size')) }
    catch { return new Response(request.method === 'HEAD' ? null : 'Invalid image size', { status: 400, headers }) }
    const { body, mime } = await reader.readForServeAsync(toStoredAssetPath(abs, root), request.signal, size)
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { ...headers, 'Content-Type': mime, 'Content-Length': String(body.length) }
    })
  } catch (error) {
    const status = error instanceof AssetReadQueueFullError ? 503
      : error instanceof AssetReadTooLargeError || error instanceof AssetPixelLimitError ? 413 : 404
    const message = status === 503 ? 'Busy' : status === 413 ? 'Image Too Large' : 'Not Found'
    return new Response(request.method === 'HEAD' ? null : message, { status, headers })
  }
}

const DOT_DOT_SEGMENT = /(?:^|[\\/])(?:\.|%2e)(?:\.|%2e)(?=$|[\\/])/i

export function resolveMediaAssetPath(requestUrl: string, root: string): string | null {
  if (DOT_DOT_SEGMENT.test(requestUrl.replace(/^media:\/\//i, ''))) {
    return null
  }

  const url = new URL(requestUrl)
  const rel = path.normalize(path.join(url.hostname, decodeURIComponent(url.pathname)))
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel)
  const relative = path.relative(rootAbs, abs)

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return abs
}

export function toStoredAssetPath(absPath: string, root: string): string {
  return path.relative(path.resolve(root), path.resolve(absPath)).split(path.sep).join('/')
}
