import { Film } from 'lucide-react'
import { WebButton } from './WebButton'
import styles from './WebStatus.module.css'

export default function WebStatus({
  error,
  retry
}: {
  error: string
  retry?: () => void
}): JSX.Element {
  return (
    <div className={styles.root} role={retry ? 'alert' : 'status'}>
      <Film aria-hidden="true" />
      <p>{error}</p>
      {retry && <WebButton onClick={retry}>重试</WebButton>}
    </div>
  )
}
