import { WebButton } from './WebButton'
import styles from './WebBrowseSort.module.css'

export default function WebBrowseSort({ value, onChange }: {
  value: string | null
  onChange: (value: string) => void
}): JSX.Element {
  return <div className={styles.root}>
    <div className={styles.options} data-web-sort data-navigation-group aria-label="排序">
      {[
        ['recent', '最近添加'],
        ['released', '最新发行'],
        ['rating', '高分影片'],
        ['code', '番号']
      ].map(([option, label]) => <WebButton key={option} aria-pressed={(value || 'recent') === option}
        onClick={() => onChange(option)}>{label}</WebButton>)}
    </div>
  </div>
}
