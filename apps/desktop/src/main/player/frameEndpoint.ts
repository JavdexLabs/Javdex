import type { IpcMainEvent, WebContents } from 'electron'

export interface FrameBinding { surfaceToken: string; bindingToken: string }
export function isFrameBinding(value: unknown): value is FrameBinding {
  if (!value || typeof value !== 'object') return false
  const v = value as FrameBinding
  return typeof v.surfaceToken === 'string' && v.surfaceToken.length > 0 && v.surfaceToken.length <= 64
    && typeof v.bindingToken === 'string' && /^[\da-f-]{36}$/.test(v.bindingToken)
}
/** Shared binding authentication and monotonic clock exchange. Native resource
 * ownership remains in the transport adapter; renderer delivery is not a fence. */
export function createFrameEndpoint(contents: WebContents, surfaceToken: string, active: () => boolean, now: () => number) {
  const trusted = (event: IpcMainEvent): boolean => !contents.isDestroyed()
    && event.sender === contents && event.senderFrame === contents.mainFrame
  const matches = (event: IpcMainEvent, value: unknown): value is FrameBinding =>
    trusted(event) && isFrameBinding(value) && value.surfaceToken === surfaceToken
  const clock = (event: IpcMainEvent, value: unknown): void => {
    if (!active() || !matches(event, value)) return
    const sentAt = (value as FrameBinding & { sentAt?: unknown }).sentAt
    if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt < 0) return
    contents.send('playback:frame-clock', { surfaceToken, bindingToken: value.bindingToken, sentAt, mainTime: now() })
  }
  return { trusted, matches, clock }
}
