import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Button from './Button'
import Modal from './Modal'
import styles from './Toast.module.css'

type ToastKind = 'info' | 'success' | 'error'
interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

interface ToastCtx {
  show: (message: string, kind?: ToastKind) => void
}

const Ctx = createContext<ToastCtx>({ show: () => {} })

export function useToast(): ToastCtx {
  return useContext(Ctx)
}

let counter = 0

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const [detail, setDetail] = useState<ToastItem | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const copySession = useRef(0)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => {
    copySession.current += 1
    for (const timer of timers.current) clearTimeout(timer)
  }, [])
  const closeDetail = (): void => { copySession.current += 1; setDetail(null) }

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++counter
    setItems((prev) => kind === 'error' && prev.some(item => item.kind === kind && item.message === message)
      ? prev : [...prev, { id, message, kind }])
    if (kind === 'error') return
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, 3600)
    timers.current.add(timer)
  }, [])

  const value = useMemo(() => ({ show }), [show])

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className={styles.stack} hidden={Boolean(detail)} aria-live="polite" aria-relevant="additions" role="status">
        {items.map((t) => (
          <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`}>
            <div className={t.kind === 'error' ? styles.summary : undefined}>{t.message}</div>
            {t.kind === 'error' && <div className={styles.actions}>
              <Button size="sm" onClick={() => { copySession.current += 1; setCopyStatus(''); setDetail(t) }}>查看详情</Button>
              <Button size="sm" onClick={() => setItems(prev => prev.filter(item => item.id !== t.id))}>关闭</Button>
            </div>}
          </div>
        ))}
      </div>
      {detail && <Modal title="错误详情" onCancel={closeDetail} actions={<>
        <span role="status" className={styles.copyStatus}>{copyStatus}</span>
        <Button onClick={() => {
          const session = ++copySession.current
          void navigator.clipboard.writeText(detail.message)
            .then(() => { if (copySession.current === session) setCopyStatus('已复制') })
            .catch(() => { if (copySession.current === session) setCopyStatus('复制失败，请选择正文手动复制') })
        }}>复制</Button>
        <Button onClick={closeDetail}>关闭</Button>
      </>}>
        <p className={styles.detail}>{detail.message}</p>
      </Modal>}
    </Ctx.Provider>
  )
}
