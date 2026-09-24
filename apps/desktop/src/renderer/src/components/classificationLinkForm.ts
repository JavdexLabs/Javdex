import { useRef, useState } from 'react'

export function moveClassificationLink<T>(
  links: readonly T[],
  fromIndex: number,
  toIndex: number
): T[] {
  if (
    fromIndex < 0 ||
    fromIndex >= links.length ||
    toIndex < 0 ||
    toIndex >= links.length ||
    fromIndex === toIndex
  ) {
    return [...links]
  }
  const next = [...links]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

export function useClassificationLinkKeys(initialCount: number): {
  linkKeys: string[]
  moveLinkKey: (fromIndex: number, toIndex: number) => void
  removeLinkKey: (index: number) => void
  appendLinkKey: () => void
} {
  const nextKey = useRef(initialCount)
  const [linkKeys, setLinkKeys] = useState(() =>
    Array.from({ length: initialCount }, (_, index) => `classification-link-${index}`)
  )
  return {
    linkKeys,
    moveLinkKey: (fromIndex, toIndex) =>
      setLinkKeys((current) => moveClassificationLink(current, fromIndex, toIndex)),
    removeLinkKey: (index) =>
      setLinkKeys((current) => current.filter((_, itemIndex) => itemIndex !== index)),
    appendLinkKey: () =>
      setLinkKeys((current) => [...current, `classification-link-${nextKey.current++}`])
  }
}
