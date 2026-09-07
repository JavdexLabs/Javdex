import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useBlocker } from 'react-router-dom'
import Modal from '../components/Modal'
import Button from '../components/Button'

type FormEntry = {
  label: string
  dirty: boolean
  busy?: boolean
  save?: () => Promise<boolean>
  discard: () => void
}
type GuardContext = {
  entries: Map<string, FormEntry>
  requestLeave: (action: () => void) => void
  notify: () => void
}
const Context = createContext<GuardContext | null>(null)

export function useSettingsFormGuard(entry: FormEntry): (action: () => void) => void {
  const context = useContext(Context)
  const id = useId()
  const entryRef = useRef(entry)
  entryRef.current = entry
  useEffect(() => {
    if (!context) return
    context.entries.set(id, {
      get label() {
        return entryRef.current.label
      },
      get dirty() {
        return entryRef.current.dirty
      },
      get busy() {
        return entryRef.current.busy
      },
      get save() {
        return entryRef.current.save
      },
      discard: () => entryRef.current.discard()
    })
    context.notify()
    return () => {
      context.entries.delete(id)
      context.notify()
    }
  }, [context, id])
  useEffect(() => {
    context?.notify()
  }, [context, entry.dirty, entry.busy])
  return context?.requestLeave ?? ((action) => action())
}

export default function SettingsLeaveGuard({ children }: { children: ReactNode }): JSX.Element {
  const entries = useRef(new Map<string, FormEntry>()).current
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, notify] = useReducer((value: number) => value + 1, 0)
  const requestLeave = useCallback(
    (action: () => void) => {
      if (Array.from(entries.values()).some((entry) => entry.dirty || entry.busy)) {
        setError(null)
        setPending(() => action)
      } else action()
    },
    [entries]
  )
  const context = useMemo(() => ({ entries, requestLeave, notify }), [entries, requestLeave])
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search) &&
      Array.from(entries.values()).some((entry) => entry.dirty || entry.busy)
  )
  const forms = Array.from(entries.values()).filter((entry) => entry.dirty || entry.busy)
  const blocked = blocker.state === 'blocked'
  const visible = blocked || pending !== null
  const busy = saving || forms.some((entry) => entry.busy)

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!Array.from(entries.values()).some((entry) => entry.dirty || entry.busy)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [entries])

  const cancel = (): void => {
    setPending(null)
    setError(null)
    if (blocked) blocker.reset()
  }
  const finish = (): void => {
    const action = pending
    setPending(null)
    setError(null)
    if (blocked) blocker.proceed()
    else action?.()
  }
  const discard = (): void => {
    forms.forEach((entry) => entry.discard())
    finish()
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      for (const entry of forms) {
        if (entry.dirty && (!entry.save || !(await entry.save()))) {
          setError(`“${entry.label}”未保存，请继续编辑并检查输入。`)
          return
        }
      }
      finish()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Context.Provider value={context}>
      {children}
      {visible ? (
        <Modal
          title="有未保存的设置"
          onCancel={cancel}
          busy={busy}
          actions={
            <>
              <Button disabled={busy} onClick={cancel}>
                继续编辑
              </Button>
              <Button disabled={busy} onClick={discard}>
                放弃更改
              </Button>
              {forms.every((entry) => !entry.dirty || entry.save) ? (
                <Button variant="primary" disabled={busy} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存后离开'}
                </Button>
              ) : null}
            </>
          }
        >
          <p>以下设置尚未保存：{forms.map((entry) => entry.label).join('、')}。</p>
          {busy ? <p role="status">正在保存，请稍候。</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </Modal>
      ) : null}
    </Context.Provider>
  )
}
