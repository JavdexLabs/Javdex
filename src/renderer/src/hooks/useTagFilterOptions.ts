import { useEffect, useState } from 'react'
import type { TagFilterOptionsPage } from '@shared/commonTypes'
import { api } from '../api'

interface Snapshot extends TagFilterOptionsPage {
  key: string
  loading: boolean
  error?: string
}

export function useTagFilterOptions(open: boolean, search: string, offset: number, retry: number): Omit<Snapshot, 'key'> {
  const key = JSON.stringify([search, offset, retry])
  const [snapshot, setSnapshot] = useState<Snapshot>()
  useEffect(() => {
    if (!open) { setSnapshot(undefined); return }
    let active = true
    setSnapshot({ key, items: [], hasMore: false, loading: true })
    api.tags.filterOptions({ search, offset, limit: 100 })
      .then(page => {
        if (active) setSnapshot({ key, ...page, loading: false })
      })
      .catch(error => {
        if (active) setSnapshot({ key, items: [], hasMore: false, loading: false,
          error: String(error?.message ?? error) })
      })
    return () => { active = false }
  }, [open, key, search, offset])
  return open && snapshot?.key === key ? snapshot : { items: [], hasMore: false, loading: open }
}
