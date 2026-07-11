import { useEffect, useState } from 'react'
import { LoaderCircle, Pause, Play, Square } from 'lucide-react'
import IconButton from '../IconButton'
import { UI_ICON_SM } from '../iconDefaults'

export type BatchControlAction = 'pause' | 'resume' | 'discard'
export type BatchControlHandler = () => boolean | void | Promise<boolean | void>

interface BatchTaskControlsProps {
  scopeLabel: string
  running: boolean
  paused: boolean
  status: string
  variant?: 'icon' | 'button'
  showDisabled?: boolean
  onPause: BatchControlHandler
  onResume: BatchControlHandler
  onDiscard: BatchControlHandler
}

export default function BatchTaskControls({
  scopeLabel,
  running,
  paused,
  status,
  variant = 'button',
  showDisabled = true,
  onPause,
  onResume,
  onDiscard
}: BatchTaskControlsProps): JSX.Element | null {
  const [pendingAction, setPendingAction] = useState<BatchControlAction | null>(null)
  const controlsBusy = pendingAction !== null
  const controllable = running || paused
  const pauseText = '\u6682\u505c'
  const resumeText = '\u7ee7\u7eed'
  const discardText = '\u7ec8\u6b62'
  const batchTaskText = '\u6279\u91cf\u4efb\u52a1'
  const controlText = '\u63a7\u5236'

  useEffect(() => {
    if (!pendingAction) return
    if (pendingAction === 'pause' && !running) {
      setPendingAction(null)
      return
    }
    if (pendingAction === 'resume' && !paused) {
      setPendingAction(null)
      return
    }
    if (pendingAction === 'discard' && ['idle', 'cancelled', 'done'].includes(status)) {
      setPendingAction(null)
    }
  }, [paused, pendingAction, running, status])

  const runControl = async (
    action: BatchControlAction,
    handler: BatchControlHandler
  ): Promise<void> => {
    if (pendingAction) return
    setPendingAction(action)
    try {
      const accepted = await handler()
      if (accepted === false) {
        setPendingAction(null)
      }
    } catch {
      setPendingAction(null)
    }
  }

  if (!showDisabled && !controllable) return null

  const pauseIcon =
    pendingAction === 'pause' ? <LoaderCircle {...UI_ICON_SM} /> : <Pause {...UI_ICON_SM} />
  const resumeIcon =
    pendingAction === 'resume' ? <LoaderCircle {...UI_ICON_SM} /> : <Play {...UI_ICON_SM} />
  const discardIcon =
    pendingAction === 'discard' ? <LoaderCircle {...UI_ICON_SM} /> : <Square {...UI_ICON_SM} />

  if (variant === 'icon') {
    return (
      <span
        className="settings-overview-batch-actions batch-task-controls batch-task-controls--icon"
        role="group"
        aria-label={`${scopeLabel}${batchTaskText}${controlText}`}
      >
        {running ? (
          <IconButton
            className="settings-overview-batch-icon-btn"
            icon={pauseIcon}
            label={`${pauseText}${scopeLabel}${batchTaskText}`}
            aria-busy={pendingAction === 'pause' || undefined}
            disabled={controlsBusy}
            onClick={() => void runControl('pause', onPause)}
          />
        ) : (
          <IconButton
            className="settings-overview-batch-icon-btn"
            icon={resumeIcon}
            label={`${resumeText}${scopeLabel}${batchTaskText}`}
            aria-busy={pendingAction === 'resume' || undefined}
            disabled={!paused || controlsBusy}
            onClick={() => void runControl('resume', onResume)}
          />
        )}
        <IconButton
          className="settings-overview-batch-icon-btn settings-overview-batch-icon-btn--danger"
          icon={discardIcon}
          label={`${discardText}${scopeLabel}${batchTaskText}`}
          aria-busy={pendingAction === 'discard' || undefined}
          disabled={!controllable || controlsBusy}
          onClick={() => void runControl('discard', onDiscard)}
        />
      </span>
    )
  }

  return (
    <div
      className="batch-action-row batch-action-row--compact batch-task-controls batch-task-controls--button"
      role="group"
      aria-label={`${scopeLabel}${batchTaskText}${controlText}`}
    >
      <button
        type="button"
        className="btn btn-sm"
        aria-busy={pendingAction === 'pause' || undefined}
        disabled={!running || controlsBusy}
        onClick={() => void runControl('pause', onPause)}
      >
        {pauseIcon}
        {pauseText}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        aria-busy={pendingAction === 'resume' || undefined}
        disabled={!paused || controlsBusy}
        onClick={() => void runControl('resume', onResume)}
      >
        {resumeIcon}
        {resumeText}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        aria-busy={pendingAction === 'discard' || undefined}
        disabled={!controllable || controlsBusy}
        onClick={() => void runControl('discard', onDiscard)}
      >
        {discardIcon}
        {discardText}
      </button>
    </div>
  )
}
