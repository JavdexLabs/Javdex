import { createHash } from 'node:crypto'
import { getAIConfiguration, validateAIConfiguration } from './aiConfigurationRepository'

export interface AgentDefinition {
  id: 'plugin-developer' | 'library-curator'
  useCase: 'plugin-developer' | 'library-curator'
  systemPrompt: string
  modelRoles: readonly ['primary', 'verifier', 'summarizer']
  toolPackRefs: readonly string[]
}

const DEFINITIONS: readonly AgentDefinition[] = [
  {
    id: 'plugin-developer',
    useCase: 'plugin-developer',
    systemPrompt: [
      '你是 Javdex 插件开发助手。',
      '使用提供的插件与浏览器工具完成发现、最小代码修改、dry-run 和语义验证。',
      '已有实质代码时优先局部修改。成功结束前必须通过 dry-run 与 verify。',
      '需要用户完成浏览器验证时使用 session_request_user。'
    ].join('\n'),
    modelRoles: ['primary', 'verifier', 'summarizer'],
    toolPackRefs: ['toolpack:plugin-developer:v1']
  },
  {
    id: 'library-curator',
    useCase: 'library-curator',
    systemPrompt: '你是 Javdex 媒体库只读整理助手。仅使用允许的只读工具总结媒体库状态。',
    modelRoles: ['primary', 'verifier', 'summarizer'],
    toolPackRefs: ['toolpack:library-curator:v1']
  }
]

export class AgentConfiguration {
  getDefinition(definitionId: string): AgentDefinition {
    const definition = DEFINITIONS.find((item) => item.id === definitionId)
    if (!definition) throw new Error(`Agent Definition 不存在：${definitionId}`)
    return definition
  }

  getProfile(profileId: string) {
    const document = getAIConfiguration()
    const errors = validateAIConfiguration(document)
    if (errors.length > 0) throw new Error(`AI 配置无效：${errors.join('；')}`)
    const profile = document.agentProfiles.find((item) => item.id === profileId)
    if (!profile) throw new Error(`Agent Profile 不存在：${profileId}`)
    const definition = this.getDefinition(profile.definitionId)
    if (profile.toolPackRefs.join('\0') !== definition.toolPackRefs.join('\0')) {
      throw new Error(`Agent Profile ${profile.id} 的 ToolPack 与 Definition 不匹配`)
    }
    return { revision: document.revision, profile: structuredClone(profile), definition }
  }

  stableSystemPrompt(definitionId: string) {
    const text = this.getDefinition(definitionId).systemPrompt
    return { text, sha256: createHash('sha256').update(text).digest('hex') }
  }
}

export const agentConfiguration = new AgentConfiguration()
