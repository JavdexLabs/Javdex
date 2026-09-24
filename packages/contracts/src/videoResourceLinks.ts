import type {
  ExternalVideoResourceKind,
  LinkVideoResourceKind,
  VideoResourceSizeUnit
} from './videoTypes'

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

export function inferVideoResourceKind(rawLocator: string): ExternalVideoResourceKind {
  const lower = rawLocator.trim().toLowerCase()
  if (lower.startsWith('magnet:?')) return 'magnet'
  if (lower.startsWith('ed2k://')) return 'ed2k'
  return inferHttpVideoResourceKind(rawLocator)
}

function decodeProtocolName(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' ')).trim()
  } catch {
    return value.trim()
  }
}

function normalizeMagnet(rawLocator: string): NormalizedExternalVideoResource {
  const locator = rawLocator.trim()
  let parsed: URL
  try {
    parsed = new URL(locator)
  } catch {
    throw new Error('Magnet 链接格式不正确')
  }
  const exactTopic = parsed.searchParams
    .getAll('xt')
    .find((value) => value.toLowerCase().startsWith('urn:btih:'))
  const hash = exactTopic?.slice('urn:btih:'.length).trim()
  if (!hash) throw new Error('Magnet 链接缺少 BTIH 标识')
  const displayName = parsed.searchParams.get('dn')
  return {
    kind: 'magnet',
    locator,
    resourceKey: `magnet:btih:${hash.toLowerCase()}`,
    suggestedDisplayName: displayName ? decodeProtocolName(displayName) : hash.slice(0, 12)
  }
}

function normalizeEd2k(rawLocator: string): NormalizedExternalVideoResource {
  const locator = rawLocator.trim()
  const parts = locator.split('|')
  if (
    parts.length < 6 ||
    parts[0].toLowerCase() !== 'ed2k://' ||
    parts[1].toLowerCase() !== 'file'
  ) {
    throw new Error('ED2K 链接格式不正确')
  }
  const fileName = decodeProtocolName(parts[2])
  const hash = parts[4].trim()
  if (!fileName || !hash) throw new Error('ED2K 链接缺少文件名或文件哈希')
  return {
    kind: 'ed2k',
    locator,
    resourceKey: `ed2k:${hash.toLowerCase()}`,
    suggestedDisplayName: fileName
  }
}

export interface NormalizedExternalVideoResource {
  kind: ExternalVideoResourceKind
  locator: string
  resourceKey: string
  suggestedDisplayName: string | null
}

export function normalizeExternalVideoResource(
  rawLocator: string,
  requestedKind?: ExternalVideoResourceKind
): NormalizedExternalVideoResource {
  const inferredKind = inferVideoResourceKind(rawLocator)
  if (inferredKind === 'magnet') {
    if (requestedKind && requestedKind !== 'magnet') {
      throw new Error('资源类型与 Magnet 链接不匹配')
    }
    return normalizeMagnet(rawLocator)
  }
  if (inferredKind === 'ed2k') {
    if (requestedKind && requestedKind !== 'ed2k') {
      throw new Error('资源类型与 ED2K 链接不匹配')
    }
    return normalizeEd2k(rawLocator)
  }
  if (requestedKind === 'magnet' || requestedKind === 'ed2k') {
    throw new Error('资源类型与 HTTP/HTTPS 链接不匹配')
  }
  const normalized = normalizeHttpVideoResource(rawLocator)
  return {
    kind: requestedKind ?? inferredKind,
    ...normalized,
    suggestedDisplayName: null
  }
}

export function maskVideoResourceLocator(
  locator: string,
  kind: ExternalVideoResourceKind
): string {
  if (kind === 'magnet' || kind === 'ed2k') {
    try {
      const normalized = kind === 'magnet' ? normalizeMagnet(locator) : normalizeEd2k(locator)
      return `${kind === 'magnet' ? 'Magnet' : 'ED2K'} · ${normalized.suggestedDisplayName}`
    } catch {
      return kind === 'magnet' ? 'Magnet 链接' : 'ED2K 链接'
    }
  }
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
