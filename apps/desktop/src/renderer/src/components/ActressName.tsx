import type { ActressGender } from '@shared/actressTypes'
import styles from './ActressName.module.css'

interface Props {
  name: string
  gender?: ActressGender | null
  className?: string
}

/** Actress display name with optional gender icon when known. */
export default function ActressName({ name, gender, className }: Props): JSX.Element {
  const cls = [styles.root, className].filter(Boolean).join(' ')

  return (
    <span className={cls}>
      <span>{name}</span>
      {gender === 'female' && (
        <span className={`${styles.genderIcon} ${styles.female}`} title="女" aria-label="女">
          ♀
        </span>
      )}
      {gender === 'male' && (
        <span className={`${styles.genderIcon} ${styles.male}`} title="男" aria-label="男">
          ♂
        </span>
      )}
    </span>
  )
}
