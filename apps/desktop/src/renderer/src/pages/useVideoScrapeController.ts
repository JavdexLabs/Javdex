import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { VideoDirectorChoiceRequired, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/videoScrapeTypes'
import type { api } from '../api'

interface DirectorChoice {
  fields: VideoScrapeField[]
  site: string
  mode?: VideoScrapeUpdateMode
  choice: VideoDirectorChoiceRequired
}
type ScrapeState = { phase: 'idle' } | { phase: 'running'; choice?: DirectorChoice } | { phase: 'choice'; choice: DirectorChoice }

export function useVideoScrapeController({ video, scope, onSelected, onPending, onApplied, notify, scrape }: {
  video: Pick<ScopedVideoDetail, 'id' | 'activeLibraryId'> | null
  scope: string
  onSelected(libraryId: number, site: string): void
  onPending(videoId: number): void
  onApplied(): void
  notify(message: string, tone: 'success' | 'info' | 'error'): void
  scrape: typeof api.scrape.one
}) {
  const [snapshot, setSnapshot] = useState<{ scope: string; state: ScrapeState }>({ scope, state: { phase: 'idle' } })
  const state = snapshot.scope === scope ? snapshot.state : { phase: 'idle' } as const
  const currentScope = useRef(scope)
  currentScope.current = scope
  const request = useRef(0)
  const running = useRef<string | null>(null)
  useLayoutEffect(() => {
    request.current += 1
    running.current = null
    setSnapshot({ scope, state: { phase: 'idle' } })
    return () => { request.current += 1; running.current = null }
  }, [scope])
  const closeDirectorChoice = useCallback(() => {
    setSnapshot(current => current.scope !== currentScope.current ? current : {
      scope: current.scope,
      state: current.state.phase === 'running' ? { phase: 'running' } : { phase: 'idle' }
    })
  }, [])
  const execute = async (fields: VideoScrapeField[], site: string, mode?: VideoScrapeUpdateMode, directorSelectionId?: number) => {
    if (!video || running.current === scope || currentScope.current !== scope) return
    const token = ++request.current
    running.current = scope
    const choice = state.phase !== 'idle' ? state.choice : undefined
    setSnapshot({ scope, state: { phase: 'running', choice } })
    onSelected(video.activeLibraryId, site)
    const active = () => currentScope.current === scope && token === request.current
    let next: ScrapeState | undefined
    try {
      const result = await scrape(video.id, site || undefined, fields, mode, directorSelectionId, video.activeLibraryId)
      if (!active()) return
      if (result.directorChoice) { next = { phase: 'choice', choice: { fields, site, mode, choice: result.directorChoice } }; return }
      next = { phase: 'idle' }
      if (result.pending) {
        notify('发现多个候选，已保存到待确认中心', 'info')
        onPending(video.id)
        return
      }
      const warnings = result.warnings.length > 0
      notify(result.applied
        ? warnings ? `已更新，部分字段未应用：${result.warnings.join('；')}` : '匹配完成'
        : warnings ? `所选字段未应用：${result.warnings.join('；')}` : '所选字段无可写入内容', result.applied && !warnings ? 'success' : 'info')
      if (result.applied) onApplied()
    } catch (error) {
      if (active()) notify(`匹配失败：${(error as Error).message}`, 'error')
    } finally {
      if (active()) {
        running.current = null
        setSnapshot(current => {
          const retainedChoice = current.scope === scope && current.state.phase !== 'idle' ? current.state.choice : undefined
          return { scope, state: next ?? (retainedChoice ? { phase: 'choice', choice: retainedChoice } : { phase: 'idle' }) }
        })
      }
    }
  }
  return { execute, closeDirectorChoice, scraping: state.phase === 'running', pendingDirectorChoice: state.phase === 'idle' ? null : state.choice ?? null,
    directorChoiceBusy: state.phase === 'running' && Boolean(state.choice) }
}
