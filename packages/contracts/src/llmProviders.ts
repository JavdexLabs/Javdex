/** LLM provider catalog and helpers shared by main process and renderer. */

export const LLM_PROVIDER_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const
export type LlmProviderProtocol = typeof LLM_PROVIDER_PROTOCOLS[number]
export type LlmRuntimeApi = 'openai-completions' | Exclude<LlmProviderProtocol, 'openai-chat'>

export function isLlmProviderProtocol(value: unknown): value is LlmProviderProtocol {
  return typeof value === 'string' && LLM_PROVIDER_PROTOCOLS.includes(value as LlmProviderProtocol)
}

export function llmProtocolToRuntimeApi(protocol: LlmProviderProtocol): LlmRuntimeApi {
  return protocol === 'openai-chat' ? 'openai-completions' : protocol
}

export function llmRuntimeApiToProtocol(api: LlmRuntimeApi): LlmProviderProtocol {
  return api === 'openai-completions' ? 'openai-chat' : api
}
export type LlmModelKind = 'chat' | 'embedding'

export interface LlmModelDefinition {
  id: string
  name: string
  kind?: LlmModelKind
  /** Shipped with the app; cannot be removed in UI. */
  builtin?: boolean
  /** A preset can require a different API from the connection's discovery protocol. */
  protocol?: LlmProviderProtocol
}

export interface BuiltInLlmProviderDefinition {
  id: string
  name: string
  protocol: LlmProviderProtocol
  defaultBaseUrl: string
  /** Local inference server; API key optional. */
  local?: boolean
  /** The protocol supports Agent tool calling; individual model capabilities may vary. */
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
  baseUrl?: string
  protocol?: LlmProviderProtocol
}

export interface LlmProviderPublicConfig extends LlmProviderUserConfig {
  hasApiKey: boolean
}

export type LlmApiKeyAction = 'keep' | 'replace' | 'clear'

export interface LlmProviderConfigSaveInput {
  providerId: string
  baseUrl: string
  protocol: LlmProviderProtocol
  apiKeyAction: LlmApiKeyAction
  apiKey?: string
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
  hasApiKey: boolean
  modelCount: number
  models: LlmModelDefinition[]
}

const BUILTIN_MODEL = (id: string, name: string, protocol?: LlmProviderProtocol): LlmModelDefinition => ({
  id,
  name,
  kind: 'chat',
  builtin: true,
  ...(protocol ? { protocol } : {})
})

/** Bump when shipped model choices change; saved choices become user-managed. */
export const BUILT_IN_LLM_CATALOG_VERSION = 1

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
      BUILTIN_MODEL('deepseek-flash', 'DeepSeek V4.1 Flash'),
      BUILTIN_MODEL('deepseek-v4-pro', 'DeepSeek V4 Pro')
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('gpt-6-astra', 'GPT-6 Astra', 'openai-responses'),
      BUILTIN_MODEL('gpt-6.1-sol', 'GPT-6.1 Sol', 'openai-responses'),
      BUILTIN_MODEL('gpt-6-luna', 'GPT-6 Luna', 'openai-responses')
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('openai/gpt-6.1-sol', 'OpenAI GPT-6.1 Sol'),
      BUILTIN_MODEL('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
      BUILTIN_MODEL('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash')
    ]
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('kimi-k3', 'Kimi K3')
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('glm-5.3', 'GLM-5.3'),
      BUILTIN_MODEL('glm-5.3-flash', 'GLM-5.3 Flash'),
      BUILTIN_MODEL('glm-5.3-flashx', 'GLM-5.3 FlashX')
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
      BUILTIN_MODEL('Qwen/Qwen3.6-27B', 'Qwen3.6 27B'),
      BUILTIN_MODEL('Qwen/Qwen3.6-35B-A3B', 'Qwen3.6 35B A3B'),
      BUILTIN_MODEL('Pro/zai-org/GLM-5.1', 'GLM-5.1')
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.minimax.cn/anthropic',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('MiniMax-M3', 'MiniMax M3'),
      BUILTIN_MODEL('MiniMax-M2.7', 'MiniMax M2.7'),
      BUILTIN_MODEL('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed')
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'google-generative-ai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('gemini-3.8-flash', 'Gemini 3.8 Flash'),
      BUILTIN_MODEL('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite')
    ]
  },
  {
    id: 'bailian',
    name: '阿里云百炼',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('qwen3.8-max', 'Qwen3.8 Max'),
      BUILTIN_MODEL('qwen3.7-plus', 'Qwen3.7 Plus'),
      BUILTIN_MODEL('qwen3.8-flash', 'Qwen3.8 Flash')
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    agentCompatible: true,
    models: [
      BUILTIN_MODEL('claude-fable-5-1', 'Claude Fable 5.1'),
      BUILTIN_MODEL('claude-opus-5-5', 'Claude Opus 5.5'),
      BUILTIN_MODEL('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
      BUILTIN_MODEL('claude-haiku-5-5', 'Claude Haiku 5.5')
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
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'google-generative-ai', label: 'Google Gemini' }
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
  hasApiKey: boolean
  modelCount: number
}): LlmProviderStatus {
  if (!input.agentCompatible) return 'unsupported'
  if (input.local) return input.modelCount > 0 ? 'ready' : 'unconfigured'
  if (!input.hasApiKey) return 'unconfigured'
  return input.modelCount > 0 ? 'ready' : 'unconfigured'
}

export interface LlmSettingsSlice {
  defaultLlmProviderId: string
  defaultLlmModelId: string
  llmProviderConfigs: Record<string, LlmProviderPublicConfig>
  customLlmProviders: CustomLlmProviderDefinition[]
  llmCustomModels: LlmCustomModelDefinition[]
}

export function buildLlmProviderViewModels(settings: LlmSettingsSlice): LlmProviderViewModel[] {
  const views: LlmProviderViewModel[] = BUILT_IN_LLM_PROVIDERS.map((provider) => {
    const userConfig = settings.llmProviderConfigs[provider.id]
    const protocol = userConfig?.protocol ?? provider.protocol
    const models = listModelsForProvider(provider.id, settings.llmCustomModels)
    const hasApiKey = userConfig?.hasApiKey === true
    const baseUrl = resolveProviderBaseUrl(provider.id, userConfig)
    return {
      id: provider.id,
      name: provider.name,
      protocol,
      baseUrl,
      source: 'builtin',
      local: provider.local === true,
      agentCompatible: provider.agentCompatible,
      hasApiKey,
      models,
      modelCount: models.length,
      status: resolveProviderStatus({
        protocol,
        agentCompatible: provider.agentCompatible,
        local: provider.local,
        hasApiKey,
        modelCount: models.length
      })
    }
  })

  for (const custom of settings.customLlmProviders) {
    const userConfig = settings.llmProviderConfigs[custom.id]
    const protocol = userConfig?.protocol ?? custom.protocol
    const models = listModelsForProvider(custom.id, settings.llmCustomModels)
    const hasApiKey = userConfig?.hasApiKey === true
    const agentCompatible = true
    views.push({
      id: custom.id,
      name: custom.name,
      protocol,
      baseUrl: resolveProviderBaseUrl(custom.id, userConfig, custom),
      source: 'custom',
      local: false,
      agentCompatible,
      hasApiKey,
      models,
      modelCount: models.length,
      status: resolveProviderStatus({
        protocol,
        agentCompatible,
        hasApiKey,
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
  const readyProviders = listAgentCompatibleProviders(settings).filter(
    (item) => item.status === 'ready'
  )
  if (readyProviders.length === 0) {
    return { providerId: '', modelId: '' }
  }

  const requestedProviderId = settings.defaultLlmProviderId.trim()
  const provider =
    readyProviders.find((item) => item.id === requestedProviderId) ??
    readyProviders.find((item) => item.id === 'deepseek') ??
    readyProviders[0]

  const models = listModelsForProvider(provider.id, settings.llmCustomModels)
  const requestedModelId = settings.defaultLlmModelId.trim()
  const modelId = models.some((model) => model.id === requestedModelId)
    ? requestedModelId
    : (models[0]?.id ?? '')

  return { providerId: provider.id, modelId }
}
