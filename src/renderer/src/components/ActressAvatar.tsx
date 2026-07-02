import { useEffect, useState } from 'react'
import type { ActressGender } from '@shared/types'

interface Props {
  src: string | null | undefined
  name: string
  gender?: ActressGender | null
  className?: string
  decorative?: boolean
}

function genderClass(gender: ActressGender | null | undefined): string {
  if (gender === 'female') return 'actress-avatar-default--female'
  if (gender === 'male') return 'actress-avatar-default--male'
  return 'actress-avatar-default--unknown'
}

export default function ActressAvatar({
  src,
  name,
  gender,
  className,
  decorative = false
}: Props): JSX.Element {
  const [failed, setFailed] = useState(false)
  const resolvedSrc = src?.trim() || null

  useEffect(() => {
    setFailed(false)
  }, [resolvedSrc])

  const classes = ['actress-avatar', className].filter(Boolean).join(' ')
  const showImage = Boolean(resolvedSrc && !failed)

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
        <span className={`actress-avatar-default ${genderClass(gender)}`} aria-hidden="true">
          <span className="actress-avatar-default-glow" />
          <span className="actress-avatar-default-hair" />
          <span className="actress-avatar-default-head" />
          <span className="actress-avatar-default-body" />
        </span>
      )}
    </span>
  )
}
