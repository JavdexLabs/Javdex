import { useEffect, useState } from 'react'
import { api } from '../api'

const emptyLabels: ReadonlyMap<number, string> = new Map()

/** One selected-label snapshot; omitted/deleted IDs are completed lookups, not retry triggers. */
export function useTagLabels(ids: number[], enabled: boolean): ReadonlyMap<number, string> {
  const key = JSON.stringify(ids.length <= 100
    ? [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
    : [])
  const [snapshot, setSnapshot] = useState<{ key: string; labels: ReadonlyMap<number, string> }>()

  useEffect(() => {
    if (!enabled || key === '[]') return
    let active = true
    api.tags.labels(JSON.parse(key) as number[])
      .then(rows => {
        if (active) setSnapshot({ key, labels: new Map(rows.map(row => [row.id, row.label])) })
      })
      .catch(() => {
        // The chip retains its numeric ID. Retry only on a new selection or surface activation.
        if (active) setSnapshot({ key, labels: emptyLabels })
      })
    return () => { active = false }
  }, [key, enabled])

  return snapshot?.key === key ? snapshot.labels : emptyLabels
}
