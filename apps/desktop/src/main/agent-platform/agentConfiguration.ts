import { createHash } from 'node:crypto'
import type { AgentPolicy, AgentToolEffect } from '@shared/aiConfigurationTypes'
import type { ModelWorkloadId } from '@shared/modelManagementTypes'
import { PLUGIN_DEVELOPER_SYSTEM_PROMPT } from '../services/pluginDevAgent/pluginDevInstructions'
import { AGENT_METADATA_COLLECTOR_SYSTEM_PROMPT } from '../services/agentMetadata/agentMetadataInstructions'
import { PLAYLIST_IMPORTER_SYSTEM_PROMPT } from '../services/playlistImport/playlistImportInstructions'
import { modelManagement } from './modelManagement'

export interface AgentDefinition {
  id: 'plugin-developer' | 'library-curator' | 'metadata-collector' | 'playlist-importer'
  useCase: 'plugin-developer' | 'library-curator' | 'metadata-collector' | 'playlist-importer'
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
    capabilityGrants: [
      'plugin.test',
      'plugin.workspace.read',
      'plugin.write',
      'browser.read',
      'browser.interact'
    ],
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
  },
  {
    id: 'playlist-importer',
    useCase: 'playlist-importer',
    systemPrompt: PLAYLIST_IMPORTER_SYSTEM_PROMPT,
    toolPackRefs: ['toolpack:playlist-importer:v1'],
    capabilityGrants: [
      'browser.interact',
      'playlist-import.stage-page',
      'playlist-import.stage-identity'
    ],
    approvalRequiredEffects: []
  }
]

function workloadIdForDefinition(definitionId: AgentDefinition['id']): ModelWorkloadId {
  return definitionId === 'metadata-collector' || definitionId === 'playlist-importer'
    ? 'library-curator'
    : definitionId
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

  getConfiguration(definitionId: AgentDefinition['id']) {
    const definition = this.getDefinition(definitionId)
    const snapshot = this.management.read()
    const workloadId = workloadIdForDefinition(definition.id)
    const assignment = snapshot.assignments.find((item) => item.workloadId === workloadId)
    if (!assignment) throw new Error(`缺少 Agent 用途配置：${workloadId}`)
    const policy: AgentPolicy = {
      toolPackRefs: [...definition.toolPackRefs],
      capabilityGrants: [...definition.capabilityGrants],
      approvalRequiredEffects: [...definition.approvalRequiredEffects]
    }
    return {
      revision: snapshot.revision,
      policy,
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
