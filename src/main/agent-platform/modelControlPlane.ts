import { randomUUID } from 'node:crypto'
import type { ModelRole } from '@shared/aiConfigurationTypes'
import { getEffectiveLlmApiKey } from '../settings/settingsStore'
import { llmFetch } from '../utils/llmFetch'
import { getAIConfiguration, validateAIConfiguration } from './aiConfigurationRepository'
import type { CredentialLease, FrozenModelAccessSnapshot, ResolvedModelAccess } from './types'

const LEASE_TTL_MS = 5 * 60 * 1000

function credentialProviderId(credentialRef: string): string {
  const prefix = 'llm-provider:'
  if (!credentialRef.startsWith(prefix)) throw new Error(`不支持的 credentialRef：${credentialRef}`)
  return credentialRef.slice(prefix.length)
}

function issueCredentialLease(credentialRef: string): CredentialLease {
  let revoked = false
  const expiresAt = Date.now() + LEASE_TTL_MS
  return {
    leaseId: randomUUID(),
    credentialRef,
    expiresAt,
    resolve(): string {
      if (revoked) throw new Error('模型凭据租约已撤销')
      if (Date.now() >= expiresAt) throw new Error('模型凭据租约已过期')
      const providerId = credentialProviderId(credentialRef)
      const secret = getEffectiveLlmApiKey(providerId)
      if (secret) return secret
      if (providerId === 'ollama' || providerId === 'lmstudio') return 'local-runtime'
      throw new Error(`模型连接 ${providerId} 没有可用凭据`)
    },
    revoke(): void { revoked = true }
  }
}

export class ModelControlPlane {
  resolveAgentModel(profileId: string, role: ModelRole): ResolvedModelAccess {
    const document = getAIConfiguration()
    const errors = validateAIConfiguration(document)
    if (errors.length > 0) throw new Error(`AI 配置无效：${errors.join('；')}`)
    const profile = document.agentProfiles.find((item) => item.id === profileId)
    if (!profile) throw new Error(`Agent Profile 不存在：${profileId}`)
    const route = document.routes.find((item) => item.id === profile.routes[role])
    if (!route) throw new Error(`Agent Profile 缺少 ${role} Route`)
    const model = document.modelRecords.find((item) => item.id === route.modelRecordId)
    const preset = document.modelPresets.find((item) => item.id === route.presetId)
    const connection = document.modelConnections.find((item) => item.id === model?.connectionId)
    if (!model || !preset || !connection) throw new Error(`Route ${route.id} 的引用不完整`)
    if (!connection.enabled) throw new Error(`模型连接「${connection.name}」未启用`)
    if (model.capabilities.tools !== true && role === 'primary') {
      throw new Error(`模型「${model.name}」没有明确的工具调用能力`)
    }
    if (preset.cacheRetention === 'long' && !model.cache.supportsLongCacheRetention) {
      throw new Error(`模型「${model.name}」没有明确支持 long cache retention`)
    }
    return {
      credentialRef: connection.credentialRef,
      model: {
        providerId: connection.providerId,
        modelId: model.modelId,
        name: model.name,
        api: model.api,
        baseUrl: connection.baseUrl,
        contextWindow: model.contextWindow,
        maxTokens: Math.min(model.maxTokens, preset.maxTokens),
        reasoning: model.capabilities.reasoning === true
      },
      routeRevision: `${document.revision}:${route.id}`,
      preset: {
        thinkingLevel: preset.thinkingLevel,
        maxTokens: preset.maxTokens,
        timeoutMs: preset.timeoutMs,
        cacheRetention: preset.cacheRetention
      },
      cacheCompatibility: structuredClone(model.cache),
      getCredentialLease: async () => issueCredentialLease(connection.credentialRef),
      fetch: llmFetch
    }
  }

  restoreAgentModel(snapshot: FrozenModelAccessSnapshot): ResolvedModelAccess {
    if (!snapshot.credentialRef.startsWith('llm-provider:')) {
      throw new Error('冻结模型配置的 credentialRef 无效')
    }
    if (snapshot.preset.cacheRetention === 'long' && !snapshot.cacheCompatibility.supportsLongCacheRetention) {
      throw new Error('冻结模型配置请求 long cache，但没有明确兼容证据')
    }
    return {
      credentialRef: snapshot.credentialRef,
      model: structuredClone(snapshot.descriptor),
      routeRevision: snapshot.routeRevision,
      preset: structuredClone(snapshot.preset),
      cacheCompatibility: structuredClone(snapshot.cacheCompatibility),
      getCredentialLease: async () => issueCredentialLease(snapshot.credentialRef),
      fetch: llmFetch
    }
  }
}

export const modelControlPlane = new ModelControlPlane()
