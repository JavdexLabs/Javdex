import { lazy, Suspense, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { PlaybackTarget } from '@shared/desktop/playback'
import { useDesktopSession } from '../desktop/DesktopSessionContext'

const SubtitleTasksDialog = lazy(() => import('./SubtitleTasksDialog'))

export default function SubtitleTasksModal({ target, onClose }: { target?: PlaybackTarget; onClose(): void }): JSX.Element | null {
  const libraryId = target?.libraryId, videoId = target?.videoId, resourceId = target?.resourceId
  const stableTarget = useMemo(() => libraryId != null && videoId != null && resourceId != null
    ? { libraryId, videoId, resourceId } : undefined, [libraryId, videoId, resourceId])
  const { session } = useDesktopSession()
  if (target && session.mode !== 'local') return null
  return <Suspense fallback={<span role="status">{target ? '正在打开字幕管理…' : '正在打开字幕任务…'}</span>}>
    {createPortal(<SubtitleTasksDialog target={stableTarget} onClose={onClose} />, document.body)}
  </Suspense>
}
