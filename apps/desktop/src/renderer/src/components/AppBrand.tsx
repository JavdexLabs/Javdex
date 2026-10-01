import styles from './AppBrand.module.css'

/** Sidebar / chrome wordmark for Javdex. */
export default function AppBrand(): JSX.Element {
  return (
    <div className={styles.root} aria-label="Javdex">
      <span className={styles.wordmark} aria-hidden="true">
        <span className={styles.first}>Jav</span>
        <span className={styles.second}>dex</span>
      </span>
    </div>
  )
}
