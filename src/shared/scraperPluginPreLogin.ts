import type { ScraperPluginSource } from './scraperPluginTypes'

const GITHUB_HOST = /(?:^|\.)github\.com$|(?:^|\.)github\.io$/i

export function scraperPluginPreLoginHomeUrl(homepage?: string | null): string | null {
  const raw = homepage?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.replace(/^www\./i, '')
    if (GITHUB_HOST.test(host)) return null
    return url.toString()
  } catch {
    return null
  }
}

export function scraperPluginPreLoginAvailable(input: {
  source?: ScraperPluginSource
  requiresConfiguration?: boolean
  homepage?: string | null
}): boolean {
  if (input.source === 'composite') return false
  if (input.requiresConfiguration) return false
  return scraperPluginPreLoginHomeUrl(input.homepage) != null
}
