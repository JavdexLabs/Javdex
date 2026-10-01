import type { ReactNode } from 'react'
import { LogOut } from 'lucide-react'
import WebBrand from './WebBrand'
import { WebButton } from './WebButton'
import { route } from './navigation'
import styles from './WebLibraryShell.module.css'

export default function WebLibraryShell({ username, onLogout, onSkip, search, collection, navigation, children }: {
  username: string; onLogout: () => void; onSkip: () => void
  search: ReactNode; collection: ReactNode; navigation: ReactNode; children: ReactNode
}): JSX.Element {
  return <div>
    <a className={styles.skip} data-web-skip href="#main-content" onClick={event => {
      event.preventDefault()
      onSkip()
    }}>跳到内容</a>
    <header className={styles.header} data-navigation-region="header">
      <WebBrand href={route('/browse')} description="本地媒体库" />
      {search}
      <WebButton className={styles.logout} data-web-logout onClick={onLogout} aria-label={`${username}，退出登录`}>
        <LogOut aria-hidden="true" /><span>退出</span>
      </WebButton>
    </header>
    {collection}
    {navigation}
    <main id="main-content" className={styles.main} data-navigation-region="content">
      {children}
      <footer className={styles.footer}>Javdex · 你的收藏，尽在此处。<span>局域网 · 只读</span></footer>
    </main>
  </div>
}
