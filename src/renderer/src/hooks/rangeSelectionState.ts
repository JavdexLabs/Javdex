interface SelectableItem {
  id: number
}

export function toggleSelectedId(current: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function addSelectedRange(
  current: ReadonlySet<number>,
  items: readonly SelectableItem[],
  anchor: number,
  index: number
): Set<number> {
  const next = new Set(current)
  const start = Math.min(anchor, index)
  const end = Math.max(anchor, index)
  for (let position = start; position <= end; position += 1) {
    const id = items[position]?.id
    if (id != null) next.add(id)
  }
  return next
}
