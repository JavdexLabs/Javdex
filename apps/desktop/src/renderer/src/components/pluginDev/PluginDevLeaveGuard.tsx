import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import Modal from '../Modal'
import { useNavigationGuard, type NavigationDecision } from '../../interaction/NavigationGuard'

type PluginDevLeaveGuardContextValue = {
  setNeedsConfirm: (value: boolean) => void
  setMessage: (message: string) => void
  requestLeave: (action: () => void) => void
}

const PluginDevLeaveGuardContext = createContext<PluginDevLeaveGuardContextValue | null>(null)

const defaultGuard: PluginDevLeaveGuardContextValue = {
  setNeedsConfirm: () => {},
  setMessage: () => {},
  requestLeave: (action) => {
    action()
  }
}

export function usePluginDevLeaveGuard(): PluginDevLeaveGuardContextValue {
  return useContext(PluginDevLeaveGuardContext) ?? defaultGuard
}

export function PluginDevLeaveGuardProvider({ children }: { children: ReactNode }): JSX.Element {
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [message, setMessage] = useState('插件有未安装的更改，离开后将无法在刮削中使用。')
  const [showModal, setShowModal] = useState(false)
  const pendingActionRef = useRef<(() => void) | null>(null)
  const needsConfirmRef = useRef(needsConfirm)
  const routePendingRef = useRef<NavigationDecision | null>(null)

  needsConfirmRef.current = needsConfirm

  const confirmLeave = useCallback(() => {
    setShowModal(false)
    const action = pendingActionRef.current
    pendingActionRef.current = null
    needsConfirmRef.current = false
    setNeedsConfirm(false)
    const decision = routePendingRef.current
    routePendingRef.current = null
    if (decision) decision.proceed()
    else action?.()
  }, [])

  const cancelLeave = useCallback(() => {
    setShowModal(false)
    pendingActionRef.current = null
    routePendingRef.current?.reset()
    routePendingRef.current = null
  }, [])

  const requestLeave = useCallback(
    (action: () => void) => {
      if (!needsConfirm) {
        action()
        return
      }
      pendingActionRef.current = action
      setShowModal(true)
    },
    [needsConfirm]
  )

  useNavigationGuard(() => needsConfirmRef.current, decision => {
    routePendingRef.current = decision
    pendingActionRef.current = null
    setShowModal(true)
  })
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!needsConfirmRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  const value = useMemo(
    () => ({
      setNeedsConfirm,
      setMessage,
      requestLeave
    }),
    [requestLeave]
  )

  return (
    <PluginDevLeaveGuardContext.Provider value={value}>
      {children}
      {showModal && (
        <Modal
          title="未安装的插件更改"
          confirmText="仍要离开"
          cancelText="留在本页"
          danger
          onConfirm={confirmLeave}
          onCancel={cancelLeave}
        >
          <p>{message}</p>
        </Modal>
      )}
    </PluginDevLeaveGuardContext.Provider>
  )
}
