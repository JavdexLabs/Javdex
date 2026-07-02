import { useMemo, useState } from 'react'
import { Plug, Trash2 } from 'lucide-react'
import Modal from '../Modal'
import IconButton from '../IconButton'
import { UI_ICON_COMPACT } from '../iconDefaults'
import { useToast } from '../Toast'
import { api } from '../../api'
import { listModelsForProvider, type LlmCustomModelDefinition, type LlmProviderViewModel } from '@shared/llmProviders'
import { SettingsFormField } from './SettingsPrimitives'

export default function LlmProviderModelsModal({
  provider,
  customModels,
  onClose,
  onAdd,
  onRemove
}: {
  provider: LlmProviderViewModel
  customModels: LlmCustomModelDefinition[]
  onClose: () => void
  onAdd: (modelId: string, modelName: string) => void
  onRemove: (modelId: string) => void
}): JSX.Element {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelName, setModelName] = useState('')
  const [testingModelId, setTestingModelId] = useState<string | null>(null)

  const models = useMemo(
    () => listModelsForProvider(provider.id, customModels),
    [provider.id, customModels]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (model) => model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)
    )
  }, [models, query])

  const customIds = new Set(
    customModels.filter((item) => item.providerId === provider.id).map((item) => item.id)
  )

  const testConnection = async (targetModelId: string): Promise<void> => {
    if (testingModelId) return
    setTestingModelId(targetModelId)
    try {
      await api.settings.testLlmModel(provider.id, targetModelId)
      toast.show('连接测试成功', 'success')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '连接测试失败', 'error')
    } finally {
      setTestingModelId(null)
    }
  }

  return (
    <Modal
      title={`${provider.name} — 模型管理`}
      size="md"
      className="modal--llm-models"
      confirmText="关闭"
      cancelText="取消"
      onCancel={onClose}
      onConfirm={onClose}
    >
      <div className="llm-models-panel">
        <input
          className="text-input"
          type="search"
          value={query}
          placeholder="搜索模型…"
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="llm-models-list" role="list">
          {filtered.map((model) => (
            <div key={model.id} className="llm-models-row" role="listitem">
              <div className="llm-models-row-copy">
                <strong>{model.name}</strong>
                <span>{model.id}</span>
              </div>
              <div className="llm-models-row-tags">
                <span className="llm-model-tag">文本</span>
                {model.builtin ? <span className="llm-model-tag llm-model-tag--builtin">内置</span> : null}
              </div>
              <div className="llm-models-row-actions">
                <IconButton
                  className="llm-models-icon-btn"
                  icon={<Plug {...UI_ICON_COMPACT} />}
                  label="测试连接"
                  title="测试连接"
                  disabled={testingModelId !== null}
                  aria-busy={testingModelId === model.id}
                  onClick={() => void testConnection(model.id)}
                />
                {!model.builtin && customIds.has(model.id) ? (
                  <IconButton
                    className="llm-models-icon-btn llm-models-icon-btn--danger"
                    icon={<Trash2 {...UI_ICON_COMPACT} />}
                    label="删除"
                    title="删除"
                    onClick={() => onRemove(model.id)}
                  />
                ) : null}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="settings-empty-panel">没有匹配的模型</div>}
        </div>

        <div className="llm-models-add">
          <SettingsFormField label="模型 ID *">
            <input
              className="text-input"
              value={modelId}
              placeholder="例如 gpt-5.5"
              onChange={(e) => setModelId(e.target.value)}
            />
          </SettingsFormField>
          <SettingsFormField label="模型名称">
            <input
              className="text-input"
              value={modelName}
              placeholder="例如 GPT-5.5"
              onChange={(e) => setModelName(e.target.value)}
            />
          </SettingsFormField>
          <div className="llm-models-add-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                onAdd(modelId, modelName)
                setModelId('')
                setModelName('')
              }}
            >
              添加模型
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
