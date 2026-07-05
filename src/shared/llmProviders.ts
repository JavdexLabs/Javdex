/** LLM provider catalog and helpers shared by main process and renderer. */

export type LlmProviderProtocol = 'openai-chat' | 'anthropic-messages'
export type LlmModelKind = 'chat' | 'embedding'

export interface LlmModelDefinition {
  id: string
  name: string
  kind?: LlmModelKind
  /** Shipped with the app; cannot be removed in UI. */
  builtin?: boolean
}

export interface BuiltInLlmProviderDefinition {
  id: string
  name: string
  protocol: LlmProviderProtocol
  defaultBaseUrl: string
  /** Local inference server; API key optional. */
  local?: boolean
  /** Agent tool-calling requires OpenAI-compatible chat completions. */
  agentCompatible: boolean
  models: LlmModelDefinition[]
}

export interface CustomLlmProviderDefinition {
  id: string
  name: string
  protocol: LlmProviderProtocol
  baseUrl: string
}

export interface LlmCustomModelDefinition {
  providerId: string
  id: string
  name: string
}

export interface LlmProviderUserConfig {
  apiKey?: string
  baseUrl?: string
  protocol?: LlmProviderProtocol
}

export type LlmProviderStatus = 'ready' | 'unconfigured' | 'unsupported'

export interface LlmProviderViewModel {
  id: string
  name: string
  protocol: LlmProviderProtocol
  baseUrl: string
  source: 'builtin' | 'custom'
  local: boolean
  agentCompatible: boolean
  status: LlmProviderStatus
  apiKey: string
  modelCount: number
  models: LlmModelDefinition[]
}

const BUILTIN_MODEL = (id: string, name: string): LlmModelDefinition => ({
  id,
  name,
  kind: 'chat',
  builtin: true
})

export const BUILT_IN_LLM_PROVIDERS: BuiltInLlmProviderDefinition[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'openai-chat',
    defaultBaseUrl: 'http://localhost:11434/v1',
    local: true,
    agentCompatible: true,
    models: []
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    protocol: 'openai-chat',
    defaultBaseUrl: 'http://localhost:1234/v1',
    local: true,
    agentCompatible: true,
    models: []
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.deepseek.com',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('deepseek-v4-flash', 'DeepSeek V4 Flash'),
      BUILTIN_MODEL('deepseek-v4-pro', 'DeepSeek V4 Pro')
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('gpt-5.5', 'GPT-5.5'),
      BUILTIN_MODEL('gpt-5.5-pro', 'GPT-5.5 Pro'),
      BUILTIN_MODEL('gpt-5.4-mini', 'GPT-5.4 Mini'),
      BUILTIN_MODEL('gpt-5.4-nano', 'GPT-5.4 Nano')
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('openai/gpt-5.5', 'OpenAI GPT-5.5'),
      BUILTIN_MODEL('anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6'),
      BUILTIN_MODEL('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash')
    ]
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('kimi-k2.6', 'Kimi K2.6'),
      BUILTIN_MODEL('kimi-k2.5', 'Kimi K2.5'),
      BUILTIN_MODEL('kimi-k2.7-code', 'Kimi K2.7 Code')
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('glm-5.2', 'GLM-5.2'),
      BUILTIN_MODEL('glm-5.1', 'GLM-5.1'),
      BUILTIN_MODEL('glm-5', 'GLM-5'),
      BUILTIN_MODEL('glm-4.7', 'GLM-4.7'),
      BUILTIN_MODEL('glm-4-flash', 'GLM-4 Flash')
    ]
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash'),
      BUILTIN_MODEL('deepseek-ai/DeepSeek-V4-Pro', 'DeepSeek V4 Pro'),
      BUILTIN_MODEL('Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen3 235B Instruct'),
      BUILTIN_MODEL('Qwen/Qwen3-32B', 'Qwen3 32B')
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('MiniMax-M3', 'MiniMax M3'),
      BUILTIN_MODEL('MiniMax-M2.7', 'MiniMax M2.7'),
      BUILTIN_MODEL('MiniMax-M2.5', 'MiniMax M2.5'),
      BUILTIN_MODEL('MiniMax-M2.1', 'MiniMax M2.1')
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('claude-sonnet-4-6', 'Claude Sonnet 4.6'),
      BUILTIN_MODEL('claude-opus-4-8', 'Claude Opus 4.8'),
      BUILTIN_MODEL('claude-haiku-4-5', 'Claude Haiku 4.5')
    ]
  }
]

export const BUILT_IN_LLM_PROVIDER_BY_ID = new Map(
  BUILT_IN_LLM_PROVIDERS.map((provider) => [provider.id, provider])
)

const BUILT_IN_LLM_PROVIDER_ORDER = new Map(
  BUILT_IN_LLM_PROVIDERS.map((provider, index) => [provider.id, index])
)

export const LLM_PROVIDER_PROTOCOL_OPTIONS: Array<{ id: LlmProviderProtocol; label: string }> = [
  { id: 'openai-chat', label: 'OpenAI Chat Completions' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' }
]

export function getLlmProtocolLabel(protocol: LlmProviderProtocol): string {
  return LLM_PROVIDER_PROTOCOL_OPTIONS.find((option) => option.id === protocol)?.label ?? protocol
}

export function inferLlmModelKind(model: Pick<LlmModelDefinition, 'id' | 'name' | 'kind'>): LlmModelKind {
  if (model.kind) return model.kind
  const text = `${model.id} ${model.name}`.toLowerCase()
  if (
    /\b(embed|embedding|embeddings|rerank|reranker)\b/.test(text) ||
    text.includes('text-embedding') ||
    text.includes('nomic-embed') ||
    text.includes('bge-') ||
    text.includes('gte-')
  ) {
    return 'embedding'
  }
  return 'chat'
}

export function getLlmModelKindLabel(kind: LlmModelKind): string {
  return kind === 'embedding' ? '嵌入' : '生成'
}

export function isValidCustomLlmProviderId(value: string): boolean {
  return /^[a-z][a-z0-9_-]{1,47}$/.test(value.trim())
}

export function normalizeCustomLlmProviderId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function isReservedLlmProviderId(id: string): boolean {
  return BUILT_IN_LLM_PROVIDER_BY_ID.has(id)
}

export function maskLlmApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (!trimmed) return '未设置'
  if (trimmed.length <= 8) return '••••••••'
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`
}

export function resolveProviderBaseUrl(
  providerId: string,
  userConfig: LlmProviderUserConfig | undefined,
  custom?: CustomLlmProviderDefinition
): string {
  const override = userConfig?.baseUrl?.trim()
  if (override) return override.replace(/\/+$/, '')
  if (custom) return custom.baseUrl.trim().replace(/\/+$/, '')
  const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.get(providerId)
  return builtIn?.defaultBaseUrl.replace(/\/+$/, '') ?? ''
}

export function listModelsForProvider(
  providerId: string,
  customModels: LlmCustomModelDefinition[]
): LlmModelDefinition[] {
  const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.get(providerId)
  const builtinModels = builtIn?.models ?? []
  const extra = customModels
    .filter((model) => model.providerId === providerId)
    .map((model) => {
      const item = { id: model.id, name: model.name.trim() || model.id }
      return { ...item, kind: inferLlmModelKind(item) }
    })
  const seen = new Set<string>()
  const merged: LlmModelDefinition[] = []
  for (const model of [...builtinModels, ...extra]) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    merged.push(model)
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function resolveProviderStatus(input: {
  protocol: LlmProviderProtocol
  agentCompatible: boolean
  local?: boolean
  apiKey: string
  modelCount: number
}): LlmProviderStatus {
  if (!input.agentCompatible) return 'unsupported'
  if (input.local) return input.modelCount > 0 ? 'ready' : 'unconfigured'
  if (!input.apiKey.trim()) return 'unconfigured'
  return input.modelCount > 0 ? 'ready' : 'unconfigured'
}

export interface LlmSettingsSlice {
  defaultLlmProviderId: string
  defaultLlmModelId: string
  llmProviderConfigs: Record<string, LlmProviderUserConfig>
  customLlmProviders: CustomLlmProviderDefinition[]
  llmCustomModels: LlmCustomModelDefinition[]
}

export function buildLlmProviderViewModels(settings: LlmSettingsSlice): LlmProviderViewModel[] {
  const views: LlmProviderViewModel[] = BUILT_IN_LLM_PROVIDERS.map((provider) => {
    const userConfig = settings.llmProviderConfigs[provider.id]
    const protocol = userConfig?.protocol ?? provider.protocol
    const models = listModelsForProvider(provider.id, settings.llmCustomModels)
    const apiKey = userConfig?.apiKey?.trim() ?? ''
    const baseUrl = resolveProviderBaseUrl(provider.id, userConfig)
    return {
      id: provider.id,
      name: provider.name,
      protocol,
      baseUrl,
      source: 'builtin',
      local: provider.local === true,
      agentCompatible: provider.agentCompatible,
      apiKey,
      models,
      modelCount: models.length,
      status: resolveProviderStatus({
        protocol,
        agentCompatible: provider.agentCompatible,
        local: provider.local,
        apiKey,
        modelCount: models.length
      })
    }
  })

  for (const custom of settings.customLlmProviders) {
    const userConfig = settings.llmProviderConfigs[custom.id]
    const protocol = userConfig?.protocol ?? custom.protocol
    const models = listModelsForProvider(custom.id, settings.llmCustomModels)
    const apiKey = userConfig?.apiKey?.trim() ?? ''
    const agentCompatible = true
    views.push({
      id: custom.id,
      name: custom.name,
      protocol,
      baseUrl: resolveProviderBaseUrl(custom.id, userConfig, custom),
      source: 'custom',
      local: false,
      agentCompatible,
      apiKey,
      models,
      modelCount: models.length,
      status: resolveProviderStatus({
        protocol,
        agentCompatible,
        apiKey,
        modelCount: models.length
      })
    })
  }

  return views.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
    if (a.source === 'builtin' && b.source === 'builtin') {
      return (
        (BUILT_IN_LLM_PROVIDER_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (BUILT_IN_LLM_PROVIDER_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      )
    }
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export function findLlmProviderViewModel(
  settings: LlmSettingsSlice,
  providerId: string
): LlmProviderViewModel | null {
  return buildLlmProviderViewModels(settings).find((item) => item.id === providerId) ?? null
}

export function listAgentCompatibleProviders(settings: LlmSettingsSlice): LlmProviderViewModel[] {
  return buildLlmProviderViewModels(settings).filter((item) => item.agentCompatible)
}

export function normalizeDefaultLlmSelection(
  settings: LlmSettingsSlice
): { providerId: string; modelId: string } {
  const compatible = listAgentCompatibleProviders(settings)
  let providerId = settings.defaultLlmProviderId.trim()
  let provider = compatible.find((item) => item.id === providerId && item.status === 'ready')
  if (!provider) {
    provider =
      compatible.find((item) => item.id === 'deepseek' && item.status === 'ready') ??
      compatible.find((item) => item.status === 'ready') ??
      compatible[0]
  }
  providerId = provider?.id ?? 'deepseek'
  const models = listModelsForProvider(providerId, settings.llmCustomModels)
  let modelId = settings.defaultLlmModelId.trim()
  if (!models.some((model) => model.id === modelId)) {
    modelId = models[0]?.id ?? 'deepseek-v4-flash'
  }
  return { providerId, modelId }
}
