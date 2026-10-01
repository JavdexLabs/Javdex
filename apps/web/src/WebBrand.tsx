import appIcon from '../../../build/icon-128.png'
import styles from './WebBrand.module.css'

export default function WebBrand({ href, description, className = '' }: {
  href?: string; description?: string; className?: string
}): JSX.Element {
  const content = <><img className={styles.mark} src={appIcon} alt="" />Javdex
    {description && <span className={styles.description}>{description}</span>}</>
  return href ? <a className={`${styles.root} ${className}`} href={href}>{content}</a>
    : <div className={`${styles.root} ${className}`}>{content}</div>
}
