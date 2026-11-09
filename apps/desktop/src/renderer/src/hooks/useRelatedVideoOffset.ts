import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'

const PAGE_SIZE = 60

/** Related-video URL offset; a null session hash lets navigation own when it resets. */
export function useRelatedVideoOffset(
  sessionHash: string | null,
  pageSize = PAGE_SIZE,
  param: typeof LIST_PARAM.relatedVideoOffset | typeof LIST_PARAM.actressVideoOffset = LIST_PARAM.relatedVideoOffset
) {
  const [params, setParams] = useSearchParams()
  const { state } = useLocation()
  const currentWriter = useRef(setParams)
  currentWriter.current = setParams
  const live = useRef(false)
  useLayoutEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const raw = params.get(param), value = Number(raw)
  const parsedOffset = raw && /^\d+$/.test(raw) && Number.isSafeInteger(value) ? Math.floor(value / pageSize) * pageSize : 0
  const previousHash = useRef(sessionHash)
  const [clearing, setClearing] = useState(false)
  const resetting = previousHash.current !== sessionHash || clearing
  const blockAnchor = useRef(false)
  blockAnchor.current = resetting
  const offset = resetting ? 0 : parsedOffset
  const move = useCallback((next: number) => {
    if (!live.current || currentWriter.current !== setParams || blockAnchor.current) return
    if (!Number.isSafeInteger(next) || next < 0) return
    const page = Math.floor(next / pageSize) * pageSize
    const normalized = page ? String(page) : null
    if (raw === normalized) return
    setParams(current => patchSearchParams(current, { [param]: normalized }), { replace: true, state })
  }, [raw, pageSize, param, setParams, state])
  const align = useCallback((known: boolean, total: number) => {
    if (!live.current || currentWriter.current !== setParams || resetting) return
    const next = known && offset >= total ? Math.max(0, Math.floor((total - 1) / pageSize) * pageSize) : offset
    if (raw !== (next ? String(next) : null)) {
      setParams(current => patchSearchParams(current, { [param]: next ? String(next) : null }), { replace: true, state })
    }
  }, [resetting, offset, raw, pageSize, param, setParams, state])
  useEffect(() => {
    const changed = previousHash.current !== sessionHash
    previousHash.current = sessionHash
    if (changed) {
      setClearing(true)
      if (raw) setParams(current => patchSearchParams(current, { [param]: null }), { replace: true, state })
      return
    }
    if (clearing) {
      if (raw) setParams(current => patchSearchParams(current, { [param]: null }), { replace: true, state })
      else setClearing(false)
    }
  }, [sessionHash, clearing, raw, param, setParams, state])
  return { offset, move, align }
}
