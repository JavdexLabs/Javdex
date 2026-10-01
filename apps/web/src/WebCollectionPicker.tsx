import { useRef } from 'react'
import { ChevronRight, X } from 'lucide-react'
import type { WebCollection } from '../../../packages/contracts/src/webTypes'
import { WebButton } from './WebButton'
import styles from './WebCollectionPicker.module.css'

export default function WebCollectionPicker({ libraries, playlists, currentLibrary, currentPlaylist, onSelect }: {
  libraries: WebCollection[]; playlists: WebCollection[]
  currentLibrary?: WebCollection; currentPlaylist?: WebCollection
  onSelect: (scope: string, pointer: boolean) => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const currentScope = currentLibrary ? `library:${currentLibrary.id}` : currentPlaylist ? `playlist:${currentPlaylist.id}` : 'all'
  return <>
    <div className={styles.bar} data-navigation-region="header">
      浏览范围
      <WebButton type="button" data-web-collection-trigger aria-haspopup="dialog"
        aria-describedby="collection-keyboard-help" aria-label="选择媒体库或清单" onClick={() => {
          dialog.current?.showModal()
          dialog.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
        }}>
        <span>{currentLibrary?.name || currentPlaylist?.name || '全部影片'}</span><ChevronRight aria-hidden="true" />
      </WebButton>
      <span id="collection-keyboard-help" className={styles.help}>按 Enter 或空格打开浏览范围，方向键移动，确认后切换，Esc 取消。</span>
    </div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="collection-title" data-navigation-region="collection">
      <div className={styles.heading}><h2 id="collection-title">浏览范围</h2>
        <WebButton type="button" aria-label="关闭浏览范围" onClick={() => dialog.current?.close()}><X aria-hidden="true" /></WebButton>
      </div>
      <div className={styles.options} data-navigation-group>
        {[
          { label: '', entries: [{ value: 'all', name: '全部影片' }] },
          { label: '媒体库', entries: libraries.map(l => ({ value: `library:${l.id}`, name: `${l.name}（${l.count}）` })) },
          { label: '我的清单', entries: playlists.map(p => ({ value: `playlist:${p.id}`, name: `${p.name}（${p.count}）` })) }
        ].map(group => <section key={group.label}>
          {group.label && group.entries.length > 0 && <h3>{group.label}</h3>}
          {group.entries.map(entry => <WebButton key={entry.value} type="button" data-scope={entry.value}
            aria-pressed={entry.value === currentScope} onClick={event => {
              dialog.current?.close()
              if (entry.value !== currentScope) onSelect(entry.value, event.detail > 0)
            }}>{entry.name}</WebButton>)}
        </section>)}
      </div>
    </dialog>
  </>
}
