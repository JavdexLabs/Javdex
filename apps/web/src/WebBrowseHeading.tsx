import WebText from './WebText'
import styles from './WebBrowseHeading.module.css'

export default function WebBrowseHeading({ title, search, total }: {
  title: string
  search: string | null
  total: number | null
}): JSX.Element {
  return <div className={styles.root}>
    <div>
      <WebText tone="eyebrow" className={styles.label}>JAVDEX COLLECTION</WebText>
      <h1>{title}</h1>
      <WebText tone="muted" className={styles.description}>
        {search ? `“${search}” 的匹配影片` : '从熟悉的收藏中，找到下一部想看的。'}
      </WebText>
    </div>
    <span className={styles.count}>{total === null ? '—' : total.toLocaleString()} 部影片</span>
  </div>
}
