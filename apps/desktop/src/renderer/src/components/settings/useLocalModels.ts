import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalModelCommand, LocalModelSnapshot } from '@shared/desktop/localModels'
import { api } from '../../api'

interface SnapshotCursor {
  snapshot: LocalModelSnapshot | null
  errorEpoch: number
}
function observeSnapshot(cursor: SnapshotCursor, value: LocalModelSnapshot): void {
  const previous = cursor.snapshot
  // Repeated idle snapshots can retain a historical manager error. A new failure
  // or operation transition must remain visible even if its message is identical.
  if (value.error && (previous?.error !== value.error || previous.operation !== value.operation)) cursor.errorEpoch++
  cursor.snapshot = value
}

/** Events win over reads and command responses that began before the event. */
export function useLocalModels() {
  const [state, setState] = useState<LocalModelSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [localError, setError] = useState<string | null>(null)
  const [acknowledgedErrorEpoch, setAcknowledgedErrorEpoch] = useState<number | null>(null)
  const lifetime = useRef({ mounted: false, events: 0, request: 0, requestBusy: false,
    snapshot: null as LocalModelSnapshot | null, errorEpoch: 0 })
  useEffect(() => {
    const counter = lifetime.current
    counter.mounted = true
    let active = true
    const events = counter.events
    const unsubscribe = api.settings.onLocalModelsChanged(value => {
      counter.events++
      if (active) { observeSnapshot(counter, value); setState(value) }
    })
    void api.settings.getLocalModels().then(value => {
      if (active && events === counter.events) { observeSnapshot(counter, value); setState(value) }
    }).catch(() => {
      if (active && events === counter.events) setError('本地模型状态读取失败，请重新打开此页')
    })
    return () => { active = false; counter.mounted = false; counter.request++; unsubscribe() }
  }, [])

  const execute = useCallback(async (command: LocalModelCommand): Promise<boolean> => {
    const counter = lifetime.current
    if (counter.requestBusy) return false
    counter.requestBusy = true
    const request = ++counter.request, events = counter.events
    const previousError = counter.snapshot?.error, previousErrorEpoch = counter.errorEpoch
    setBusy(true)
    try {
      const value = await api.settings.localModelCommand(command)
      if (!counter.mounted || request !== counter.request) return false
      if (events === counter.events) { observeSnapshot(counter, value); setState(value) }
      // A successful command acknowledges the old failure only. A newer error
      // delivered while the command was pending is not consumed by that success.
      if (previousError && counter.snapshot?.error === previousError && counter.errorEpoch === previousErrorEpoch) {
        setAcknowledgedErrorEpoch(previousErrorEpoch)
      }
      setError(null)
      setFeedback(command.action === 'copy-download-url' ? '下载地址已复制'
        : command.action === 'cancel-download' ? '下载已暂停，下次可继续下载'
          : command.action === 'export' ? '导出操作已结束' : '')
      return true
    } catch (cause) {
      if (counter.mounted && request === counter.request) {
        setError(cause instanceof Error ? cause.message : '本地模型操作失败')
      }
      return false
    } finally {
      counter.requestBusy = false
      if (counter.mounted && request === counter.request) setBusy(false)
    }
  }, [])

  const snapshotError = state?.error && acknowledgedErrorEpoch !== lifetime.current.errorEpoch ? state.error : null
  return { state, busy, feedback, error: localError, snapshotError, execute }
}
