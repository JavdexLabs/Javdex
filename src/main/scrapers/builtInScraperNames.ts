import type { ScraperPluginKind } from '@shared/types'

export const BUILT_IN_VIDEO_SCRAPER_NAMES = ['JavDB', 'JavLibrary', 'JAV8'] as const
export const BUILT_IN_ACTRESS_SCRAPER_NAMES = ['Xslist', '偶像档案库'] as const

export function builtInScraperNames(kind: ScraperPluginKind): readonly string[] {
  return kind === 'video' ? BUILT_IN_VIDEO_SCRAPER_NAMES : BUILT_IN_ACTRESS_SCRAPER_NAMES
}

export function isBuiltInScraperName(kind: ScraperPluginKind, name: string): boolean {
  return builtInScraperNames(kind).includes(name)
}
