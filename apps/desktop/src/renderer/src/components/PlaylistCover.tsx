import type { ReactNode } from 'react'
import { playlistCoverSource, type PlaylistCoverData } from './playlistCoverSource'
import styles from './PlaylistCover.module.css'

export default function PlaylistCover({ variant, playlist, placeholder = <span>无封面</span>, children }: {
  variant: 'card' | 'detail' | 'pick'
  playlist: PlaylistCoverData & { name: string }
  placeholder?: ReactNode
  children?: ReactNode
}): JSX.Element {
  const cover = playlistCoverSource(playlist, variant === 'pick' ? 320 : variant === 'card' ? 640 : undefined)
  return <div className={styles.root} data-variant={variant} data-builtin={cover.kind === 'builtin' || undefined}>
    {cover.url ? <img src={cover.url} alt={playlist.name} draggable={false} /> : placeholder}
    {children}
  </div>
}
