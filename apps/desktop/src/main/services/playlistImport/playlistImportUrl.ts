import { normalizeRelatedLinkUrl } from '@shared/relatedLinkUrl'
import { hasSensitiveUrlQuery } from '@shared/urlCredentialPolicy'

export function normalizePlaylistImportUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(normalizeRelatedLinkUrl(raw))
  } catch {
    throw new Error('外部清单链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (hasSensitiveUrlQuery(url)) throw new Error('PLAYLIST_IMPORT_URL_CREDENTIALS')
  return url.toString()
}
