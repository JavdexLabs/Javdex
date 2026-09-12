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
import { useNavigate } from 'react-router-dom'
import Modal from '../Modal'

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
  const navigate = useNavigate()
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [message, setMessage] = useState('插件有未安装的更改，离开后将无法在刮削中使用。')
  const [showModal, setShowModal] = useState(false)
  const pendingActionRef = useRef<(() => void) | null>(null)
  const needsConfirmRef = useRef(needsConfirm)
  const skipConfirmRef = useRef(false)
  const trapActiveRef = useRef(false)

  needsConfirmRef.current = needsConfirm

  const confirmLeave = useCallback(() => {
    setShowModal(false)
    const action = pendingActionRef.current
    pendingActionRef.current = null
    skipConfirmRef.current = true
    setNeedsConfirm(false)
    trapActiveRef.current = false
    action?.()
    window.setTimeout(() => {
      skipConfirmRef.current = false
    }, 0)
  }, [])

  const cancelLeave = useCallback(() => {
    setShowModal(false)
    pendingActionRef.current = null
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

  useEffect(() => {
    if (!needsConfirm) {
      trapActiveRef.current = false
      return
    }

    const pushHistoryTrap = (): void => {
      window.history.pushState({ pluginDevLeaveTrap: true }, '', window.location.href)
      trapActiveRef.current = true
    }

    const handlePopState = (): void => {
      if (skipConfirmRef.current || !needsConfirmRef.current) return

      pushHistoryTrap()
      pendingActionRef.current = () => {
        navigate(-2)
      }
      setShowModal(true)
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!needsConfirmRef.current || skipConfirmRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    if (!trapActiveRef.current) {
      pushHistoryTrap()
    }

    window.addEventListener('popstate', handlePopState)
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('popstate', handlePopState)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [needsConfirm, navigate])

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
          className="modal--plugin-dev-leave"
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
