import Modal from '../Modal'

export default function PluginDevConnectionModal({
  providerLabel,
  modelLabel,
  maxSteps,
  maxContextTokens,
  busy,
  onMaxStepsChange,
  onMaxContextTokensChange,
  onOpenModelSettings,
  onSave,
  onClose
}: {
  providerLabel: string
  modelLabel: string
  maxSteps: number
  maxContextTokens: number
  busy: boolean
  onMaxStepsChange: (value: number) => void
  onMaxContextTokensChange: (value: number) => void
  onOpenModelSettings: () => void
  onClose: () => void
  onSave: () => void
}): JSX.Element {
  return (
    <Modal
      title="Agent 连接配置"
      size="sm"
      className="modal--plugin-dev-connection"
      confirmText={busy ? '保存中…' : '保存'}
      cancelText="取消"
      onConfirm={onSave}
      onCancel={onClose}
    >
      <div className="plugin-dev-connection-form">
        <div className="plugin-dev-connection-default-llm">
          <div className="plugin-dev-connection-default-copy">
            <span>默认模型</span>
            <strong>{providerLabel}</strong>
            <small>{modelLabel}</small>
          </div>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onOpenModelSettings}>
            模型设置
          </button>
        </div>
        <label className="plugin-edit-control">
          <span>最大步数</span>
          <input
            className="text-input"
            type="number"
            min={0}
            max={500}
            step={1}
            value={maxSteps}
            disabled={busy}
            onChange={(e) => {
              const raw = e.target.value
              if (!raw.trim()) {
                onMaxStepsChange(0)
                return
              }
              const parsed = Number(raw)
              onMaxStepsChange(Number.isFinite(parsed) ? Math.max(0, Math.min(500, Math.round(parsed))) : 0)
            }}
          />
          <span className="plugin-dev-connection-hint">0 表示无限制；建议调试时设为 25–50。</span>
        </label>
        <label className="plugin-edit-control">
          <span>最大上下文长度</span>
          <input
            className="text-input"
            type="number"
            min={8000}
            max={512000}
            step={1000}
            value={maxContextTokens}
            disabled={busy}
            onChange={(e) => {
              const raw = e.target.value
              if (!raw.trim()) {
                onMaxContextTokensChange(128000)
                return
              }
              const parsed = Number(raw)
              onMaxContextTokensChange(Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 128000)
            }}
          />
          <span className="plugin-dev-connection-hint">
            按估算 token 控制发送给模型的输入上下文；默认 128000，超出后会自动裁剪旧消息。
          </span>
        </label>
      </div>
    </Modal>
  )
}
