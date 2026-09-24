import { shell } from 'electron'

const MAX_EXTERNAL_URL_LENGTH = 2_048

export function normalizeExternalHttpUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_EXTERNAL_URL_LENGTH) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export async function openExternalLink(rawUrl: string): Promise<boolean> {
  const url = normalizeExternalHttpUrl(rawUrl)
  if (!url) return false
  await shell.openExternal(url)
  return true
}
