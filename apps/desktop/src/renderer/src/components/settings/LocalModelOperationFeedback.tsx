import type { LocalModelCommand, LocalModelSnapshot } from '@shared/desktop/localModels'
import { localModelGroup } from '@shared/desktop/localModels'
import Button from '../Button'
import styles from './LocalModelsPanel.module.css'

export type ModelOperationFailure = NonNullable<LocalModelSnapshot['operationError']>
export function failureModel(failure?: ModelOperationFailure) {
  return failure && failure.command.action !== 'prepare-acceleration' && 'model' in failure.command ? failure.command.model : undefined
}
export function failureGroup(failure?: ModelOperationFailure) {
  const command = failure?.command
  return command?.action === 'qwen-forced-aligner' ? 'qwen-speech' : command && 'group' in command ? command.group : command?.action === 'prepare-acceleration' && command.model ? localModelGroup(command.model) : undefined
}
export default function LocalModelOperationFeedback({ failure, disabled, execute, details, detailsLabel = '错误详情', showMessage = true }: {
  failure: ModelOperationFailure; disabled: boolean; execute: (command: LocalModelCommand) => Promise<boolean>; details: () => void
  detailsLabel?: string; showMessage?: boolean
}) {
  const retryable = ['download', 'import', 'export', 'prepare-runtime', 'prepare-acceleration', 'detect-devices'].includes(failure.command.action)
  return <div className={styles.localFailure} role="alert">
    {showMessage && <span className={styles.failureMessage} title={failure.message}>{failure.message}</span>}
    {retryable && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void execute(failure.command)}>重试</Button>}
    <Button size="sm" variant="ghost" onClick={details}>{detailsLabel}</Button>
  </div>
}
