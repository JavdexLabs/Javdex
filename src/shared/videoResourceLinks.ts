import type { LinkVideoResourceKind, VideoResourceSizeUnit } from './videoTypes'

const DIRECT_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.m4v',
  '.wmv',
  '.flv',
  '.ts',
  '.m2ts'
])

export function normalizeHttpVideoResource(rawUrl: string): {
  locator: string
  resourceKey: string
} {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error('资源链接格式不正确，仅支持 HTTP/HTTPS')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('资源链接仅支持 HTTP/HTTPS')
  }
  if (!parsed.hostname) throw new Error('资源链接缺少有效域名')
  parsed.hash = ''
  const locator = parsed.toString()
  return { locator, resourceKey: `http:${locator}` }
}

export function inferHttpVideoResourceKind(rawUrl: string): LinkVideoResourceKind {
  try {
    const parsed = new URL(rawUrl.trim())
    const path = parsed.pathname.toLowerCase()
    const dot = path.lastIndexOf('.')
    if (dot >= 0 && DIRECT_VIDEO_EXTENSIONS.has(path.slice(dot))) return 'direct'
  } catch {
    // Invalid input remains a web link until field validation reports the error.
  }
  return 'web'
}

export function maskVideoResourceLocator(
  locator: string,
  kind: LinkVideoResourceKind
): string {
  try {
    const parsed = new URL(locator)
    const path = decodeURIComponent(parsed.pathname)
      .split('/')
      .filter(Boolean)
      .join('/')
    if (!path) return parsed.hostname
    if (kind === 'direct') return `${parsed.hostname} / ${path}`
    return `${parsed.hostname} / ${path}`
  } catch {
    return kind === 'direct' ? '视频直链' : '网页链接'
  }
}

export function resourceSizeToBytes(
  rawValue: string,
  unit: VideoResourceSizeUnit
): number | null {
  const trimmed = rawValue.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) throw new Error('文件大小必须是大于 0 的数值')
  const factor = unit === 'MB' ? 1024 ** 2 : unit === 'GB' ? 1024 ** 3 : 1024 ** 4
  const bytes = Math.round(value * factor)
  if (!Number.isSafeInteger(bytes)) throw new Error('文件大小超出支持范围')
  return bytes
}
