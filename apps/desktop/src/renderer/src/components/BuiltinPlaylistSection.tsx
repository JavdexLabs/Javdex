import type { useBuiltinPlaylists } from '../hooks/usePlaylistBrowsePage'
import Button from './Button'
import EmptyState from './EmptyState'
import PlaylistCard from './PlaylistCard'
import styles from './BuiltinPlaylistSection.module.css'

export default function BuiltinPlaylistSection({ lists, activeId, onOpen }: {
  lists: ReturnType<typeof useBuiltinPlaylists>
  activeId?: number | null
  onOpen: (id: number) => void
}): JSX.Element {
  return (
    <section aria-label="内置清单">
      <h2 className={styles.title}>内置清单</h2>
      {lists.items.length > 0 && (
        <div className={styles.grid}>
          {lists.items.map(item => (
            <PlaylistCard key={item.id} item={item} compact active={activeId === item.id} onOpen={() => onOpen(item.id)} />
          ))}
        </div>
      )}
      {lists.error && <EmptyState variant="compact" title="内置清单读取失败" description={lists.error}>
        <Button onClick={lists.reload}>重试</Button>
      </EmptyState>}
      {lists.recentError && <EmptyState variant="compact" title="本机最近播放读取失败" description={lists.recentError}>
        <Button onClick={() => void lists.reloadRecent()}>重试</Button>
      </EmptyState>}
      {!lists.items.length && !lists.error && !lists.recentError && (
        <EmptyState variant="compact" loading={lists.loading} title={lists.loading ? '正在读取内置清单…' : '暂无内置清单'} />
      )}
    </section>
  )
}
