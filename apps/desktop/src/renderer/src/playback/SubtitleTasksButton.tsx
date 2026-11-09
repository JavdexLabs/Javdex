import { useState } from 'react'
import type { PlaybackTarget } from '@shared/desktop/playback'
import Button from '../components/Button'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import SubtitleTasksModal from './SubtitleTasksModal'

export default function SubtitleTasksButton({ target, label = '字幕任务' }: { target?: PlaybackTarget; label?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { session } = useDesktopSession()
  if (target && session.mode !== 'local') return null
  return <>
    <Button size="sm" onClick={() => setOpen(true)}>{label}</Button>
    {open && <SubtitleTasksModal target={target} onClose={() => setOpen(false)} />}
  </>
}
