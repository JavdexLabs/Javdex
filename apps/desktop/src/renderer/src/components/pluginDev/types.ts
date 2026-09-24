import type { PluginDevAgentPhase, PluginDevSessionStatus } from '@shared/pluginDevTypes'

export type PluginKind = 'video' | 'actress'

export type PluginDevAgentTab = 'conversation' | 'result'

export type PluginDevConversationItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'agent'; text: string; turn?: number; streaming?: boolean }
  | {
      id: string
      type: 'reasoning'
      step: number
      turn: number
      text: string
      charCount: number
      truncated: boolean
      streaming?: boolean
    }
  | {
      id: string
      type: 'tool'
      step: number
      tool?: string
      summary: string
      detail?: string
      ok?: boolean
    }

export function agentStatusLabel(
  status: PluginDevSessionStatus | null,
  step: number,
  artifactReady = false
): string {
  switch (status) {
    case 'running':
      return step > 0 ? `运行中 · 第 ${step} 步` : '运行中'
    case 'waiting_user':
      return artifactReady ? '可安装' : '等待操作'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '就绪'
  }
}

export function agentPhaseLabel(phase: PluginDevAgentPhase): string {
  switch (phase) {
    case 'working':
      return '开发'
    case 'checking':
      return '检查'
    case 'ready':
      return '就绪'
    case 'waiting_user':
      return '等待'
    default:
      return '就绪'
  }
}
