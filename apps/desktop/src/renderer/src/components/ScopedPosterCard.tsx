import type { ScopedVideoCard } from '@shared/cardProjection'
import PosterCard, { type PosterCardProps } from './PosterCard'
import styles from './ScopedPosterCard.module.css'
import { mediaLibraryIdentityStyle } from './mediaLibraryIdentity'

type ScopedPosterCardProps = Omit<PosterCardProps<ScopedVideoCard>, 'video' | 'detailLibraryId'> & {
  video: ScopedVideoCard
}

export default function ScopedPosterCard({
  video,
  className = '',
  ...posterProps
}: ScopedPosterCardProps): JSX.Element {
  const preferred = video.libraries.find(
    (library) => library.libraryId === video.preferredLibraryId
  )
  const orderedLibraries = preferred
    ? [preferred, ...video.libraries.filter((library) => library.libraryId !== preferred.libraryId)]
    : video.libraries
  const visibleLibraries = orderedLibraries.slice(0, 2)
  const hiddenLibraries = orderedLibraries.slice(2)
  const hiddenCount = hiddenLibraries.length

  return (
    <div className={styles.root}>
      <PosterCard
        {...posterProps}
        className={`${styles.card}${className ? ` ${className}` : ''}`}
        video={video}
        detailLibraryId={video.preferredLibraryId}
      />
      {visibleLibraries.length > 0 ? (
        <div
          className={styles.badges}
          aria-label={`打开时使用：${preferred?.name ?? '自动选择'}；所属媒体库：${video.libraries.map((library) => library.name).join('、')}`}
        >
          {visibleLibraries.map((library) => {
            const current = library.libraryId === video.preferredLibraryId
            return (
              <span
                className={styles.badge}
                data-current={current || undefined}
                key={library.libraryId}
                title={current ? `${library.name}（打开时使用）` : library.name}
              >
                <span
                  className={styles.dot}
                  style={mediaLibraryIdentityStyle(library.color)}
                  aria-hidden
                />
                <span className={styles.name}>{library.name}</span>
              </span>
            )
          })}
          {hiddenCount > 0 ? (
            <span
              className={styles.more}
              title={hiddenLibraries.map((library) => library.name).join('、')}
            >
              +{hiddenCount}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
