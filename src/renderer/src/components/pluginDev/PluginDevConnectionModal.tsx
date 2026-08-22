import Modal from '../Modal'
import Button from '../Button'
import styles from './PluginDevConnectionModal.module.css'

export default function PluginDevConnectionModal({
  workloadLabel,
  providerLabel,
  modelLabel,
  revision,
  frozen,
  error,
  onOpenModelSettings,
  onClose
}: {
  workloadLabel: string
  providerLabel: string
  modelLabel: string
  revision: string
  frozen: boolean
  error: string | null
  onOpenModelSettings: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <Modal
      title="Agent 连接配置"

      size="sm"
      className={styles.modal}
      confirmText="关闭"
      cancelText="关闭"
      onConfirm={onClose}
      onCancel={onClose}
    >
      <div className={styles.form}>
        <div className={styles.defaultModel}>
          <div className={styles.defaultCopy}>
            <span>{workloadLabel}</span>
            <strong>{providerLabel}</strong>
            <small>{modelLabel}</small>
          </div>
          <Button type="button" size="sm" onClick={onOpenModelSettings}>
            模型设置
          </Button>
        </div>
        <dl className={styles.meta}>
          <div><dt>配置来源</dt><dd>{frozen ? '当前会话已冻结' : '插件开发用途'}</dd></div>
          <div><dt>配置版本</dt><dd title={revision}>{revision.slice(0, 12)}</dd></div>
        </dl>
        {error && <div className="settings-notice settings-notice--warning" role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
