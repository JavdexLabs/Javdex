import { randomUUID } from 'node:crypto'
import type { ModelWorkloadId } from '@shared/modelManagementTypes'
import { getEffectiveLlmApiKey } from '../settings/settingsStore'
import { llmFetch } from '../utils/llmFetch'
import { modelManagement } from './modelManagement'
import type { CredentialLease, FrozenModelAccessSnapshot, ResolvedModelAccess } from './types'

const LEASE_TTL_MS = 5 * 60 * 1000

export function resolveEffectiveMaxTokens(modelMaxTokens: number, presetMaxTokens: number): number {
  if (!Number.isSafeInteger(modelMaxTokens) || modelMaxTokens <= 0) {
    throw new Error('模型最大输出必须是正整数')
  }
  if (!Number.isSafeInteger(presetMaxTokens) || presetMaxTokens < 0) {
    throw new Error('用途最大输出必须是非负整数')
  }
  return presetMaxTokens === 0
    ? modelMaxTokens
    : Math.min(modelMaxTokens, presetMaxTokens)
}

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
  constructor(
    private readonly management: Pick<typeof modelManagement, 'resolve'> = modelManagement
  ) {}

  resolveWorkloadModel(workloadId: ModelWorkloadId): ResolvedModelAccess {
    return this.management.resolve(workloadId)
  }

  restoreAgentModel(snapshot: FrozenModelAccessSnapshot): ResolvedModelAccess {
    if (!snapshot.credentialRef.startsWith('llm-provider:')) {
      throw new Error('冻结模型配置的 credentialRef 无效')
    }
    if (snapshot.preset.cacheRetention === 'long' && !snapshot.cacheCompatibility.supportsLongCacheRetention) {
      throw new Error('冻结模型配置请求 long cache，但没有明确兼容证据')
    }
    const maxTokens = resolveEffectiveMaxTokens(
      snapshot.descriptor.maxTokens,
      snapshot.preset.maxTokens
    )
    return {
      credentialRef: snapshot.credentialRef,
      model: { ...structuredClone(snapshot.descriptor), maxTokens },
      routeRevision: snapshot.routeRevision,
      preset: { ...structuredClone(snapshot.preset), maxTokens },
      cacheCompatibility: structuredClone(snapshot.cacheCompatibility),
      getCredentialLease: async () => issueCredentialLease(snapshot.credentialRef),
      fetch: llmFetch
    }
  }
}

export const modelControlPlane = new ModelControlPlane()
