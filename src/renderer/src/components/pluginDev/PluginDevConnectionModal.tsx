import Modal from '../Modal'
import Button from '../Button'

export default function PluginDevConnectionModal({
  profileLabel,
  providerLabel,
  modelLabel,
  routeLabel,
  revision,
  error,
  onOpenModelSettings,
  onClose
}: {
  profileLabel: string
  providerLabel: string
  modelLabel: string
  routeLabel: string
  revision: string
  error: string | null
  onOpenModelSettings: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <Modal
      title="Agent 连接配置"

      size="sm"
      className="modal--plugin-dev-connection"
      confirmText="关闭"
      cancelText="关闭"
      onConfirm={onClose}
      onCancel={onClose}
    >
      <div className="plugin-dev-connection-form">
        <div className="plugin-dev-connection-default-llm">
          <div className="plugin-dev-connection-default-copy">
            <span>{profileLabel}</span>
            <strong>{providerLabel}</strong>
            <small>{modelLabel}</small>
          </div>
          <Button type="button" size="sm" onClick={onOpenModelSettings}>
            模型设置
          </Button>
        </div>
        <dl className="llm-provider-card-meta">
          <div><dt>Primary Route</dt><dd>{routeLabel}</dd></div>
          <div><dt>配置 Revision</dt><dd title={revision}>{revision.slice(0, 12)}</dd></div>
        </dl>
        {error && <div className="settings-notice settings-notice--warning" role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
