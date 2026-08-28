import type { MediaLibraryBadge } from '@shared/catalogTypes'
import styles from './VideoLibraryMembershipBadges.module.css'
import { mediaLibraryIdentityStyle } from './mediaLibraryIdentity'

const MAX_VISIBLE_LIBRARIES = 3

export interface VideoLibraryMembershipBadgesProps {
  activeLibraryId: number
  libraries: MediaLibraryBadge[]
}

/** Compact, read-only summary of the active resource scope and other memberships. */
export default function VideoLibraryMembershipBadges({
  activeLibraryId,
  libraries
}: VideoLibraryMembershipBadgesProps): JSX.Element | null {
  if (libraries.length === 0) return null

  const active = libraries.find((library) => library.libraryId === activeLibraryId)
  const others = libraries.filter((library) => library.libraryId !== activeLibraryId)
  const ordered = active ? [active, ...others] : libraries
  const visible = ordered.slice(0, MAX_VISIBLE_LIBRARIES)
  const hidden = ordered.slice(MAX_VISIBLE_LIBRARIES)
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
      {visible.map((library) => {
        const current = library.libraryId === activeLibraryId
        return (
          <span
            className={styles.badge}
            data-current={current || undefined}
            data-library-id={library.libraryId}
            key={library.libraryId}
            title={current ? `${library.name}（当前资源）` : library.name}
            aria-hidden
          >
            <span className={styles.dot} style={mediaLibraryIdentityStyle(library.color)} />
            <span className={styles.name}>{library.name}</span>
            {current ? <span className={styles.current}>当前</span> : null}
          </span>
        )
      })}
      {hidden.length > 0 ? (
        <span
          className={styles.more}
          title={hidden.map((library) => library.name).join('、')}
          aria-hidden
        >
          +{hidden.length}
        </span>
      ) : null}
    </div>
  )
}
