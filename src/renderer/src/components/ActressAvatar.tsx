import { useEffect, useState } from 'react'
import type { ActressGender } from '@shared/actressTypes'
import { useTheme } from './ThemeProvider'
import styles from './ActressAvatar.module.css'

interface Props {
  src: string | null | undefined
  name: string
  gender?: ActressGender | null
  className?: string
  decorative?: boolean
}

function genderClass(gender: ActressGender | null | undefined): string {
  if (gender === 'female') return styles.female
  if (gender === 'male') return styles.male
  return styles.unknown
}

export default function ActressAvatar({
  src,
  name,
  gender,
  className,
  decorative = false
}: Props): JSX.Element {
  const { privacyMode } = useTheme()
  const [failed, setFailed] = useState(false)
  const resolvedSrc = src?.trim() || null
  const useDefaultAvatar =
    privacyMode.privacyModeEnabled &&
    privacyMode.privacyModeScopes.includes('actressDefaultAvatar')

  useEffect(() => {
    setFailed(false)
  }, [resolvedSrc])

  const classes = [styles.root, 'actress-avatar', className].filter(Boolean).join(' ')
  const showImage = Boolean(resolvedSrc && !failed && !useDefaultAvatar)

  return (
    <span
      className={classes}
      aria-hidden={decorative ? true : undefined}
      role={!decorative && !showImage ? 'img' : undefined}
      aria-label={!decorative && !showImage ? name : undefined}
    >
      {showImage ? (
        <img src={resolvedSrc ?? ''} alt={decorative ? '' : name} onError={() => setFailed(true)} />
      ) : (
        <span className={`${styles.defaultAvatar} ${genderClass(gender)}`} aria-hidden="true">
          <span className={styles.glow} />
          <span className={styles.hair} />
          <span className={styles.head} />
          <span className={styles.body} />
        </span>
      )}
    </span>
  )
}
