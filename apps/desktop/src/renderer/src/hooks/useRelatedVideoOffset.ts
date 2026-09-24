import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'

const PAGE_SIZE = 60

/** Related-video URL offset; survives nested detail routes and clears when the browsing session changes. */
export function useRelatedVideoOffset(sessionHash: string, pageSize = PAGE_SIZE) {
  const [params, setParams] = useSearchParams()
  const raw = params.get(LIST_PARAM.relatedVideoOffset), value = Number(raw)
  const parsedOffset = raw && /^\d+$/.test(raw) && Number.isSafeInteger(value) ? Math.floor(value / pageSize) * pageSize : 0
  const previousHash = useRef(sessionHash)
  const [clearing, setClearing] = useState(false)
  const resetting = previousHash.current !== sessionHash || clearing
  const blockAnchor = useRef(false)
  blockAnchor.current = resetting
  const offset = resetting ? 0 : parsedOffset
  const move = useCallback((next: number) => {
    if (blockAnchor.current) return
    setParams(current => patchSearchParams(current, { [LIST_PARAM.relatedVideoOffset]: next > 0 ? String(next) : null }), { replace: true })
  }, [setParams])
  const align = useCallback((known: boolean, total: number) => {
    if (resetting) return
    const next = known && offset >= total ? Math.max(0, Math.floor((total - 1) / pageSize) * pageSize) : offset
    if (raw !== (next ? String(next) : null)) {
      setParams(current => patchSearchParams(current, { [LIST_PARAM.relatedVideoOffset]: next ? String(next) : null }), { replace: true })
    }
  }, [resetting, offset, raw, pageSize, setParams])
  useEffect(() => {
    const changed = previousHash.current !== sessionHash
    previousHash.current = sessionHash
    if (changed) {
      setClearing(true)
      if (raw) setParams(current => patchSearchParams(current, { [LIST_PARAM.relatedVideoOffset]: null }), { replace: true })
      return
    }
    if (clearing) {
      if (raw) setParams(current => patchSearchParams(current, { [LIST_PARAM.relatedVideoOffset]: null }), { replace: true })
      else setClearing(false)
    }
  }, [sessionHash, clearing, raw, setParams])
  return { offset, move, align }
}
