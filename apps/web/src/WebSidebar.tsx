import { Film, Library, ListVideo, ShieldCheck } from 'lucide-react'
import type { WebCollection } from '../../../packages/contracts/src/webTypes'
import { route } from './navigation'
import styles from './WebSidebar.module.css'

export default function WebSidebar({ libraries, playlists, library, playlist }: {
  libraries: WebCollection[]; playlists: WebCollection[]; library: string | null; playlist: string | null
}): JSX.Element {
  return <nav className={styles.root} data-navigation-region="sidebar" aria-label="浏览导航">
    <div className={styles.scroll} data-web-sidebar-scroll>
      <a data-active={!library && !playlist} href={route('/browse')}><Library aria-hidden="true" />全部影片</a>
      <p className={styles.label}>媒体库</p>
      {libraries.map(l => <a key={l.id} data-active={String(l.id) === library}
        href={route('/browse', new URLSearchParams({ library: String(l.id) }))}>
        <Film aria-hidden="true" /><span>{l.name}</span><small>{l.count}</small>
      </a>)}
      {playlists.length > 0 && <p className={styles.label}>我的清单</p>}
      {playlists.map(p => <a key={p.id} data-active={String(p.id) === playlist}
        href={route('/browse', new URLSearchParams({ playlist: String(p.id) }))}>
        <ListVideo aria-hidden="true" /><span>{p.name}</span><small>{p.count}</small>
      </a>)}
    </div>
    <div className={styles.foot} data-web-sidebar-foot><ShieldCheck aria-hidden="true" />
      <span>只读访问<br /><small>管理请使用桌面端</small></span>
    </div>
  </nav>
}
