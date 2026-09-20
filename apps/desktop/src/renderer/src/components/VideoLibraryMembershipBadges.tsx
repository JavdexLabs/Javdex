import type { MediaLibraryBadge } from '@shared/catalogTypes'
import styles from './VideoLibraryMembershipBadges.module.css'
import { mediaLibraryIdentityStyle } from './mediaLibraryIdentity'

export interface VideoLibraryMembershipBadgesProps {
  activeLibraryId: number
  libraries: MediaLibraryBadge[]
  onSelectLibrary: (libraryId: number) => void
}

/** Switch between the libraries containing this video. */
export default function VideoLibraryMembershipBadges({
  activeLibraryId,
  libraries,
  onSelectLibrary
}: VideoLibraryMembershipBadgesProps): JSX.Element | null {
  if (libraries.length === 0) return null

  const active = libraries.find((library) => library.libraryId === activeLibraryId)
  const others = libraries.filter((library) => library.libraryId !== activeLibraryId)
  const ordered = active ? [active, ...others] : libraries
  const activeName = active?.name ?? '未知'
  const otherNames = others.map((library) => library.name)
  const summary =
    otherNames.length > 0
      ? `当前媒体库：${activeName}；其它媒体库：${otherNames.join('、')}`
      : `当前媒体库：${activeName}`

  return (
    <div className={styles.root} aria-label={summary}>
      <span className={styles.label} aria-hidden>
        媒体库
      </span>
      {ordered.map((library) => {
        const current = library.libraryId === activeLibraryId
        return (
          <button
            type="button"
            onClick={() => {
              if (!current) onSelectLibrary(library.libraryId)
            }}
            aria-pressed={current}
            className={styles.badge}
            data-current={current || undefined}
            data-library-id={library.libraryId}
            key={library.libraryId}
            title={current ? `${library.name}（当前资源）` : library.name}
          >
            <span className={styles.dot} style={mediaLibraryIdentityStyle(library.color)} />
            <span className={styles.name}>{library.name}</span>
            {current ? <span className={styles.current}>当前</span> : null}
          </button>
        )
      })}
    </div>
  )
}
