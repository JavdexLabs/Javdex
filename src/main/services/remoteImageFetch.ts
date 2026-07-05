import path from 'node:path'
import { resolveScrapeProxyUrl } from '@shared/types'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import { getSettings } from '../settings/settingsStore'
import { readImageDimensionsFromBuffer } from './assetService'

function isValidImageBuffer(buf: Buffer): boolean {
  return buf.length > 0 && readImageDimensionsFromBuffer(buf) != null
}

async function tryFetch(
  label: string,
  fetcher: () => Promise<Buffer>
): Promise<Buffer | null> {
  try {
    const buf = await fetcher()
    if (isValidImageBuffer(buf)) return buf
    console.warn(`${label}: response is not a valid image`)
  } catch (err) {
    console.warn(`${label} failed:`, (err as Error).message)
  }
  return null
}

/**
 * Fetch a remote image for manual import/preview.
 * Mimics opening the URL in a browser tab (top-level navigation, no hotlink Referer),
 * then falls back to generic network fetch without Referer and scraper-session context.
 */
export async function fetchRemoteImageBuffer(url: string): Promise<Buffer> {
  await scrapeBrowser.setProxy(resolveScrapeProxyUrl(getSettings()))

  const attempts: Array<[string, () => Promise<Buffer>]> = [
    ['direct navigation', () => scrapeBrowser.fetchBufferViaNavigation(url)],
    ['network without referer', () => scrapeBrowser.fetchBuffer(url, { referer: 'omit' })],
    ['scraper session', () => scrapeBrowser.fetchBuffer(url, { referer: 'session' })]
  ]

  for (const [label, fetcher] of attempts) {
    const buf = await tryFetch(label, fetcher)
    if (buf) return buf
  }

  throw new Error('图片链接无法加载')
}

export const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
}

export function mimeTypeFromImageUrl(url: string): string {
  const ext = path.extname(url.split('?')[0] ?? '').toLowerCase()
  return EXT_TO_MIME[ext] ?? 'image/jpeg'
}
