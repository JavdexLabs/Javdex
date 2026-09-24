import { useEffect, type RefObject } from 'react'
import type { VideoResourceFilter } from '@shared/videoTypes'
import Button from './Button'
import FloatingLayer from './FloatingLayer'
import VideoResourceFilterFieldset from './VideoResourceFilterFieldset'
import styles from './PlaylistResourceFilterPopover.module.css'

interface PlaylistResourceFilterPopoverProps {
  id: string
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  value: VideoResourceFilter[]
  onChange: (value: VideoResourceFilter[]) => void
  onClose: () => void
}

export default function PlaylistResourceFilterPopover({
  id,
  open,
  anchorRef,
  value,
  onChange,
  onClose
}: PlaylistResourceFilterPopoverProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      onClose()
      anchorRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [anchorRef, onClose, open])

  const closeAndRestoreFocus = (): void => {
    onClose()
    window.requestAnimationFrame(() => anchorRef.current?.focus())
  }

  return (
    <FloatingLayer
      id={id}
      open={open}
      anchorRef={anchorRef}
      side="bottom"
      align="end"
      offset={8}
      className={styles.popover}
      role="dialog"
      ariaLabel="清单影片资源筛选"
      onClose={closeAndRestoreFocus}
    >
      <header className={styles.head}>
        <h3 className={styles.title}>资源筛选</h3>
      </header>
      <div className={styles.body}>
        <VideoResourceFilterFieldset value={value} onChange={onChange} />
      </div>
      <footer className={styles.footer}>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
          重置
        </Button>
        <Button type="button" variant="primary" size="sm" onClick={closeAndRestoreFocus}>
          完成
        </Button>
      </footer>
    </FloatingLayer>
  )
}
