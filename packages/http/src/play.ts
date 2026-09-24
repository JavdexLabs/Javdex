import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendFile, WebError } from './http'
import { isStructuredError } from '@shared/protocol/errors'
import type { InspectedPlayStream } from '@library/catalog/catalogPlay'

const PLAY_PATH = /^\/play\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export interface PlayHttpSurface {
  inspect(input: { grantId: string; token: string }): InspectedPlayStream | Promise<InspectedPlayStream>
}

const liveStreams = new Map<string, Set<ServerResponse>>()

export function closePlayStreams(grantIds: string[] | 'all'): void {
  const ids = grantIds === 'all' ? [...liveStreams.keys()] : grantIds
  for (const grantId of ids) {
    for (const response of liveStreams.get(grantId) ?? []) {
      if (!response.destroyed) response.destroy()
    }
    liveStreams.delete(grantId)
  }
}

function trackStream(grantId: string, response: ServerResponse): void {
  const pending = liveStreams.get(grantId) ?? new Set<ServerResponse>()
  pending.add(response)
  liveStreams.set(grantId, pending)
  const done = (): void => {
    pending.delete(response)
    if (!pending.size) liveStreams.delete(grantId)
  }
  response.once('close', done)
  response.once('finish', done)
}

export async function handlePlayHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  play: PlayHttpSurface | undefined
): Promise<boolean> {
  if (!url.pathname.startsWith('/play/v1/')) return false
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') throw new WebError(405, '播放接口仅接受 GET 或 HEAD')
  const match = PLAY_PATH.exec(url.pathname)
  if (!match) throw new WebError(404, '播放凭据无效或已过期')
  if (!play) throw new WebError(404, '播放凭据无效或已过期')
  const token = url.searchParams.get('t') ?? ''
  if (!token) throw new WebError(404, '播放凭据无效或已过期')
  let inspected: InspectedPlayStream
  try {
    inspected = await play.inspect({ grantId: match[1], token })
  } catch (error) {
    if (isStructuredError(error)) throw new WebError(404, '播放凭据无效或已过期')
    throw error
  }
  trackStream(inspected.grant.grantId, response)
  await sendFile(request, response, inspected.file, inspected.mime, inspected.stat)
  return true
}
