import type { ActressGender } from '@shared/types'

interface Props {
  name: string
  gender?: ActressGender | null
  className?: string
}

/** Actress display name with optional gender icon when known. */
export default function ActressName({ name, gender, className }: Props): JSX.Element {
  const cls = ['actress-name-with-gender', className].filter(Boolean).join(' ')

  return (
    <span className={cls}>
      <span>{name}</span>
      {gender === 'female' && (
        <span className="gender-icon gender-female" title="女" aria-label="女">
          ♀
        </span>
      )}
      {gender === 'male' && (
        <span className="gender-icon gender-male" title="男" aria-label="男">
          ♂
        </span>
      )}
    </span>
  )
}
