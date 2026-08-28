import { createHash } from 'node:crypto'
import type { AgentProfile, AgentToolEffect } from '@shared/aiConfigurationTypes'
import type { ModelWorkloadId } from '@shared/modelManagementTypes'
import { PLUGIN_DEVELOPER_SYSTEM_PROMPT } from '../services/pluginDevAgent/pluginDevInstructions'
import { AGENT_METADATA_COLLECTOR_SYSTEM_PROMPT } from '../services/agentMetadata/agentMetadataInstructions'
import { modelManagement } from './modelManagement'

export interface AgentDefinition {
  id: 'plugin-developer' | 'library-curator' | 'metadata-collector'
  useCase: 'plugin-developer' | 'library-curator' | 'metadata-collector'
  systemPrompt: string
  toolPackRefs: readonly string[]
  capabilityGrants: readonly string[]
  approvalRequiredEffects: readonly AgentToolEffect[]
}

const DEFINITIONS: readonly AgentDefinition[] = [
  {
    id: 'plugin-developer',
    useCase: 'plugin-developer',
    systemPrompt: PLUGIN_DEVELOPER_SYSTEM_PROMPT,
    toolPackRefs: ['toolpack:plugin-developer:v1'],
    capabilityGrants: ['plugin.test', 'plugin.write', 'browser.read', 'browser.interact'],
    approvalRequiredEffects: ['credential-sensitive']
  },
  {
    id: 'library-curator',
    useCase: 'library-curator',
    systemPrompt: '你是 Javdex 媒体库只读整理助手。仅使用允许的只读工具总结媒体库状态。',
    toolPackRefs: ['toolpack:library-curator:v1'],
    capabilityGrants: ['library.read'],
    approvalRequiredEffects: []
  },
  {
    id: 'metadata-collector',
    useCase: 'metadata-collector',
    systemPrompt: AGENT_METADATA_COLLECTOR_SYSTEM_PROMPT,
    toolPackRefs: ['toolpack:metadata-collector:v1'],
    capabilityGrants: ['browser.read', 'metadata.stage-remote-candidate'],
    approvalRequiredEffects: []
  }
]

function definitionIdForProfile(profileId: string): AgentDefinition['id'] {
  if (profileId.includes('plugin-developer')) return 'plugin-developer'
  if (profileId.includes('library-curator')) return 'library-curator'
  if (profileId.includes('metadata-collector')) return 'metadata-collector'
  throw new Error(`Agent Profile 不存在：${profileId}`)
}

function workloadIdForDefinition(definitionId: AgentDefinition['id']): ModelWorkloadId {
  return definitionId === 'metadata-collector' ? 'library-curator' : definitionId
}

export class AgentConfiguration {
  constructor(
    private readonly management: Pick<typeof modelManagement, 'read'> = modelManagement
  ) {}

  getDefinition(definitionId: string): AgentDefinition {
    const definition = DEFINITIONS.find((item) => item.id === definitionId)
    if (!definition) throw new Error(`Agent Definition 不存在：${definitionId}`)
    return definition
  }

  getProfile(profileId: string) {
    const definition = this.getDefinition(definitionIdForProfile(profileId))
    const snapshot = this.management.read()
    const workloadId = workloadIdForDefinition(definition.id)
    const assignment = snapshot.assignments.find((item) => item.workloadId === workloadId)
    if (!assignment) throw new Error(`缺少 Agent 用途配置：${workloadId}`)
    const virtualRoute = `workload:${workloadId}`
    const profile: AgentProfile = {
      id: profileId,
      name:
        definition.id === 'plugin-developer'
          ? '插件开发'
          : definition.id === 'metadata-collector'
            ? '外部元数据采集'
            : '媒体库整理',
      definitionId: definition.id,
      routes: {
        primary: virtualRoute,
        verifier: virtualRoute,
        summarizer: virtualRoute
      },
      toolPackRefs: [...definition.toolPackRefs],
      capabilityGrants: [...definition.capabilityGrants],
      approvalRequiredEffects: [...definition.approvalRequiredEffects],
      compaction: structuredClone(assignment.compaction)
    }
    return {
      revision: snapshot.revision,
      profile,
      definition,
      workload: structuredClone(assignment)
    }
  }

  stableSystemPrompt(definitionId: string) {
    const text = this.getDefinition(definitionId).systemPrompt
    return { text, sha256: createHash('sha256').update(text).digest('hex') }
  }
}

export const agentConfiguration = new AgentConfiguration()
