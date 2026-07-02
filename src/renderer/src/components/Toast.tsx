import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

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

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++counter
    setItems((prev) => [...prev, { id, message, kind }])
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, 3600)
  }, [])

  const value = useMemo(() => ({ show }), [show])

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-relevant="additions" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
