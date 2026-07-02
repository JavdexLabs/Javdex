import type { PluginDevAgentPhase, PluginDevSessionStatus } from '@shared/types'

export type PluginKind = 'video' | 'actress'

export type PluginDevAgentTab = 'conversation' | 'result'

export type PluginDevConversationItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'agent'; text: string }
  | {
      id: string
      type: 'tool'
      step: number
      tool?: string
      summary: string
      detail?: string
      ok?: boolean
    }

export function agentStatusLabel(status: PluginDevSessionStatus | null, step: number): string {
  switch (status) {
    case 'running':
      return step > 0 ? `运行中 · 第 ${step} 步` : '运行中'
    case 'waiting_user':
      return '等待操作'
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
    case 'discover':
      return '探测'
    case 'implement':
      return '实现'
    case 'dry_run':
      return '调试'
    case 'verify':
      return '验证'
    case 'finish':
      return '收尾'
    case 'waiting_user':
      return '等待'
    default:
      return '就绪'
  }
}
