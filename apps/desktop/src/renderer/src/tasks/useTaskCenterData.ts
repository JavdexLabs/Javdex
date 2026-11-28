import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import { actressKeys, mediaLibraryKeys } from '../query/queryKeys'
import { pendingInboxBadgeValue } from '../pendingInboxState'
import { subtitleNeedsAttention } from './taskCenterState'
import { TRANSLATION_TASKS_KEY } from './translationTaskState'

export const SUBTITLE_TASKS_KEY = ['subtitle-tasks'] as const

/** Shared lightweight queries for the navigation badge and the task workspace. */
export function useTaskCenterData() {
  const { session, catalogReadsEnabled } = useDesktopSession()
  const local = session.mode === 'local'
  const libraries = useQuery({ queryKey: mediaLibraryKeys.activeList(), queryFn: () => api.mediaLibraries.list(),
    staleTime: 2000, refetchInterval: 3000, enabled: catalogReadsEnabled })
  const video = useQuery({ queryKey: ['pending-video-scrapes', 'count'], queryFn: () => api.scrape.countPending(),
    refetchInterval: 3000, enabled: catalogReadsEnabled })
  const actress = useQuery({ queryKey: actressKeys.conflictSummary(), queryFn: () => api.actressScrape.conflictSummary(),
    refetchInterval: 3000, enabled: catalogReadsEnabled })
  const subtitles = useQuery({ queryKey: SUBTITLE_TASKS_KEY, queryFn: async () => {
    const snapshot = await api.playback.subtitleTasks()
    if (snapshot.error) throw new Error(snapshot.error)
    return snapshot
  }, staleTime: 1500, refetchInterval: 3000, enabled: local })
  const translations = useQuery({
    queryKey: [...TRANSLATION_TASKS_KEY, session.catalogId, session.serverId, session.generation, 'overview'],
    queryFn: () => api.metadataTranslation.list(),
    staleTime: 1500, refetchInterval: 2200, enabled: catalogReadsEnabled
  })
  const pending = pendingInboxBadgeValue({ libraries: libraries.data, pendingVideoCount: video.data,
    actressConflictGroupCount: actress.data?.groupCount, isError: libraries.isError || video.isError || actress.isError })
  const subtitleAttention = local ? (subtitles.data?.tasks ?? []).filter(subtitleNeedsAttention).length : 0
  const translationAttention = translations.data?.attention ?? 0
  const attention = (local && subtitles.isError) || (catalogReadsEnabled && translations.isError) ? 'error' : typeof pending !== 'number' ? pending
    : (local && !subtitles.data) || (catalogReadsEnabled && !translations.data) ? 'loading' : pending + subtitleAttention + translationAttention
  return { local, libraries, video, actress, subtitles, pending, attention, subtitleAttention, translations, translationAttention,
    refresh: async () => { await Promise.allSettled([libraries.refetch(), video.refetch(), actress.refetch(), ...(local ? [subtitles.refetch()] : []),
      ...(catalogReadsEnabled ? [translations.refetch()] : [])]) } }
}
