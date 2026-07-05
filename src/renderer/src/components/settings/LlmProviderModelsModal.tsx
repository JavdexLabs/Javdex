import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import Modal from '../Modal'
import IconButton from '../IconButton'
import { UI_ICON_COMPACT } from '../iconDefaults'
import { useToast } from '../Toast'
import { api } from '../../api'
import {
  getLlmModelKindLabel,
  inferLlmModelKind,
  listModelsForProvider,
  type LlmCustomModelDefinition,
  type LlmModelDefinition,
  type LlmProviderViewModel
} from '@shared/llmProviders'
import { SettingsFormField } from './SettingsPrimitives'

type ModelRow = LlmModelDefinition & {
  source: 'builtin' | 'custom' | 'remote'
}

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
  const [loadingRemoteModels, setLoadingRemoteModels] = useState(false)
  const [remoteModels, setRemoteModels] = useState<LlmModelDefinition[]>([])

  const savedModels = useMemo(
    () => listModelsForProvider(provider.id, customModels),
    [provider.id, customModels]
  )
  const customIds = useMemo(
    () => new Set(customModels.filter((item) => item.providerId === provider.id).map((item) => item.id)),
    [customModels, provider.id]
  )

  const models = useMemo<ModelRow[]>(() => {
    const seen = new Set<string>()
    const rows: ModelRow[] = []
    for (const model of savedModels) {
      seen.add(model.id)
      rows.push({
        ...model,
        source: model.builtin ? 'builtin' : customIds.has(model.id) ? 'custom' : 'custom'
      })
    }
    for (const model of remoteModels) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      rows.push({ ...model, source: 'remote' })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [customIds, remoteModels, savedModels])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (model) => model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)
    )
  }, [models, query])

  const testGeneration = async (targetModelId: string): Promise<void> => {
    if (testingModelId) return
    setTestingModelId(targetModelId)
    try {
      const sample = await api.settings.testLlmModel(provider.id, targetModelId)
      toast.show(`测试生成成功：${sample}`, 'success')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '测试生成失败', 'error')
    } finally {
      setTestingModelId(null)
    }
  }

  const loadRemoteModels = async (): Promise<void> => {
    if (loadingRemoteModels) return
    setLoadingRemoteModels(true)
    try {
      const discovered = await api.settings.listLlmModels(provider.id)
      setRemoteModels(discovered)
      toast.show(discovered.length ? `查询到 ${discovered.length} 个模型` : '接口未返回模型', discovered.length ? 'success' : 'info')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '查询模型失败', 'error')
    } finally {
      setLoadingRemoteModels(false)
    }
  }

  const addDiscoveredModel = (model: LlmModelDefinition): void => {
    onAdd(model.id, model.name)
    setRemoteModels((prev) => prev.filter((item) => item.id !== model.id))
  }

  return (
    <Modal
      title={`${provider.name} — 模型管理`}
      size="lg"
      className="modal--llm-models"
      confirmText="关闭"
      cancelText="取消"
      onCancel={onClose}
      onConfirm={onClose}
    >
      <div className="llm-models-panel">
        <div className="llm-models-toolbar">
          <input
            className="text-input"
            type="search"
            value={query}
            placeholder="搜索模型…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={loadingRemoteModels}
            onClick={() => void loadRemoteModels()}
          >
            <RefreshCw {...UI_ICON_COMPACT} />
            {loadingRemoteModels ? '查询中…' : '查询模型'}
          </button>
        </div>

        <div className="llm-models-list" role="list">
          {filtered.map((model) => {
              const kind = inferLlmModelKind(model)
              const canGenerate = kind === 'chat'
              return (
                <div key={model.id} className="llm-models-row" role="listitem">
                  <div className="llm-models-row-copy">
                    <strong>{model.name}</strong>
                    <span>{model.id}</span>
                  </div>
                  <div className="llm-models-row-tags">
                    <span
                      className={`llm-model-tag${
                        kind === 'embedding' ? ' llm-model-tag--embedding' : ''
                      }`}
                    >
                      {getLlmModelKindLabel(kind)}
                    </span>
                    {model.source === 'builtin' ? (
                      <span className="llm-model-tag llm-model-tag--builtin">内置</span>
                    ) : model.source === 'remote' ? (
                      <span className="llm-model-tag llm-model-tag--remote">接口</span>
                    ) : (
                      <span className="llm-model-tag">自定义</span>
                    )}
                  </div>
                  <div className="llm-models-row-actions">
                    <IconButton
                      className="llm-models-icon-btn"
                      icon={<Sparkles {...UI_ICON_COMPACT} />}
                      label="测试生成"
                      title={canGenerate ? '测试生成' : '嵌入模型不支持测试生成'}
                      disabled={!canGenerate || testingModelId !== null}
                      aria-busy={testingModelId === model.id}
                      onClick={() => void testGeneration(model.id)}
                    />
                    {model.source === 'remote' ? (
                      <IconButton
                        className="llm-models-icon-btn"
                        icon={<Plus {...UI_ICON_COMPACT} />}
                        label="添加"
                        title={canGenerate ? '添加到本地模型' : '嵌入模型不能作为生成模型添加'}
                        disabled={!canGenerate}
                        onClick={() => addDiscoveredModel(model)}
                      />
                    ) : !model.builtin && customIds.has(model.id) ? (
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
              )
            })}
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
