import { useCallback, useReducer } from 'react'
import type { ScraperPluginPackage } from '@shared/scrapeTypes'
import type { PluginKind } from './types'

export interface PluginDevDraft {
  kind: PluginKind
  siteName: string
  siteUrl: string
  testTarget: string
  description: string
  version: string
  author: string
  supportedFieldIds: string[]
  code: string
}

export function newPluginDevDraft(kind: PluginKind = 'video'): PluginDevDraft {
  return { kind, siteName: '', siteUrl: '', testTarget: '', description: '', version: '1.0.0', author: 'Plugin Dev Agent', supportedFieldIds: [], code: '' }
}

export function draftFromPluginPackage(pkg: ScraperPluginPackage, current?: PluginDevDraft): PluginDevDraft {
  return {
    ...newPluginDevDraft(pkg.kind), ...current,
    kind: pkg.kind, siteName: pkg.name, siteUrl: pkg.homepage ?? current?.siteUrl ?? '',
    version: pkg.version ?? '1.0.0', description: pkg.description ?? '', author: pkg.author ?? 'Plugin Dev Agent',
    supportedFieldIds: pkg.supportedFields ?? [], code: pkg.code
  }
}

type DraftAction = { type: 'edit'; patch: Partial<PluginDevDraft> }
  | { type: 'generated'; package: ScraperPluginPackage }
  | { type: 'loaded'; package: ScraperPluginPackage }
  | { type: 'new'; kind: PluginKind }

export function pluginDevDraftReducer(state: PluginDevDraft, action: DraftAction): PluginDevDraft {
  switch (action.type) {
    case 'edit': return { ...state, ...action.patch }
    case 'generated': return draftFromPluginPackage(action.package, state)
    case 'loaded': return draftFromPluginPackage(action.package, { ...state, siteUrl: '' })
    case 'new': return newPluginDevDraft(action.kind)
  }
}

/** Draft is independent of Agent run status; a generated package is one atomic update. */
export function usePluginDevDraft() {
  const [draft, dispatch] = useReducer(pluginDevDraftReducer, undefined, () => newPluginDevDraft())
  const edit = useCallback((patch: Partial<PluginDevDraft>) => dispatch({ type: 'edit', patch }), [])
  const applyGenerated = useCallback((pkg: ScraperPluginPackage) => dispatch({ type: 'generated', package: pkg }), [])
  const load = useCallback((pkg: ScraperPluginPackage) => dispatch({ type: 'loaded', package: pkg }), [])
  const reset = useCallback((kind: PluginKind) => dispatch({ type: 'new', kind }), [])
  return { draft, edit, applyGenerated, load, reset }
}
