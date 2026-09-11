import { useCallback, useEffect, useRef, useState } from 'react'

/** Holds only one page; pending responses belong to one actor/filter/page session. */
export function useBoundedMediaPage<Page extends { total: number }>(scope: string, readPage: (offset: number) => Promise<Page | null>) {
  const [position, setPosition] = useState({ scope, offset: 0 })
  const offset = position.scope === scope ? position.offset : 0
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ key: string; pageKey: string; data: Page | null; error: string | null } | null>(null)
  const pageKey = `${scope}:${offset}`
  const navigation = useRef({ pageKey, generation: 0 })
  if (navigation.current.pageKey !== pageKey) {
    navigation.current = { pageKey, generation: navigation.current.generation + 1 }
  }
  const sessionKey = `${pageKey}:${navigation.current.generation}`
  const key = `${sessionKey}:${retry}`
  const activeKey = useRef(key)
  activeKey.current = key
  const reload = useCallback(() => setRetry(value => value + 1), [])
  const move = (next: number) => setPosition({ scope, offset: Math.max(0, next) })
  useEffect(() => {
    let cancelled = false
    void readPage(offset).then(data => {
      if (cancelled || activeKey.current !== key) return
      if (data && offset > 0 && offset >= data.total) {
        setPosition({ scope, offset: Math.max(0, Math.floor((data.total - 1) / 60) * 60) })
        return
      }
      setResult({ key, pageKey: sessionKey, data, error: null })
    }).catch(error => {
      if (!cancelled && activeKey.current === key) setResult({ key, pageKey: sessionKey, data: null, error: String(error.message ?? error) })
    })
    return () => { cancelled = true }
  }, [readPage, scope, offset, key, sessionKey])
  const current = result?.pageKey === sessionKey ? result : null
  return { data: current?.data ?? null, loading: !current || (current.error !== null && current.key !== key), error: current?.error ?? null, offset, move, reload }
}
