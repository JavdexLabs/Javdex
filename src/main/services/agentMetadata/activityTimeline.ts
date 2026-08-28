import { sanitizeUnicodeScalars, truncateUnicode } from '@shared/unicodeText'
import type { AgentMetadataActivity } from '@shared/agentMetadataTypes'
import type { RuntimeObservation } from '../../agent-platform/types'

// Each entry is independently bounded below. Action noise is capped, while reasoning turns remain
// available for the complete run so every historical thought can still be expanded by the user.
const MAX_ACTIVITIES = 256
const MAX_REASONING_CHARS = 6_000
const MAX_SUMMARY_CHARS = 240

function browserActionLabel(action: unknown): string {
  return {
    open: '打开目标详情页',
    snapshot: '读取页面结构',
    find: '查找页面内容',
    html: '提取页面标记',
    evaluate: '解析页面数据',
    click: '展开页面内容',
    wait: '等待页面加载',
    status: '检查页面状态',
    'read-section': '读取页面证据',
    handoff: '请求用户完成页面操作'
  }[String(action)] ?? '检查外部详情页'
}

function toolLabel(tool: string, args?: Record<string, unknown>): string {
  if (tool === 'browser') return browserActionLabel(args?.action)
  if (tool === 'submit_metadata_candidate') return '验证并保存元数据候选'
  return '执行 Agent 操作'
}

export class AgentMetadataActivityTimeline {
  private activities: AgentMetadataActivity[]
  private turn = 1

  constructor(initial: AgentMetadataActivity[] = []) {
    this.activities = structuredClone(initial)
    this.trimActionHistory()
    const latestReasoningTurn = this.activities.reduce(
      (latest, activity) => activity.kind === 'reasoning' ? Math.max(latest, activity.turn) : latest,
      0
    )
    this.turn = latestReasoningTurn + 1
  }

  snapshot(): AgentMetadataActivity[] {
    return structuredClone(this.activities)
  }

  describeTool(callId: string, tool: string, args: Record<string, unknown>): boolean {
    const existing = this.activities.find(
      (activity): activity is Extract<AgentMetadataActivity, { kind: 'action' }> =>
        activity.id === `action:${callId}` && activity.kind === 'action'
    )
    const label = toolLabel(tool, args)
    if (existing) {
      if (tool === 'browser' && args.action === undefined) return false
      if (existing.label === label) return false
      existing.label = label
      return true
    }
    this.append({
      id: `action:${callId}`,
      kind: 'action',
      status: 'running',
      tool,
      label
    })
    return true
  }

  observe(event: RuntimeObservation): boolean {
    if (event.type === 'reasoning.delta') return this.appendReasoning(event.text)
    if (event.type === 'message.completed' && event.audit.role === 'assistant') {
      const reasoning = this.reasoning(this.turn)
      if (reasoning) {
        reasoning.status = 'success'
        reasoning.charCount = Math.max(reasoning.charCount, event.audit.reasoningChars ?? 0)
      }
      this.turn += 1
      return Boolean(reasoning)
    }
    if (event.type === 'tool.started') {
      return this.describeTool(event.call.callId, event.call.toolName, {})
    }
    if (event.type === 'tool.progress') {
      const action = this.action(event.callId)
      const summary = truncateUnicode(event.summary, MAX_SUMMARY_CHARS, '…')
      if (!action || action.summary === summary) return false
      action.summary = summary
      return true
    }
    if (event.type === 'tool.completed') {
      const action = this.action(event.result.callId)
      const status = event.result.ok ? 'success' : 'error'
      const summary = truncateUnicode(event.result.summary, MAX_SUMMARY_CHARS, '…')
      if (action) {
        action.status = status
        action.summary = summary
      } else {
        this.append({
          id: `action:${event.result.callId}`,
          kind: 'action',
          status,
          tool: event.result.toolName,
          label: toolLabel(event.result.toolName),
          summary
        })
      }
      return true
    }
    if (event.type === 'retry.changed') {
      return this.upsertSystemAction(
        `retry:${event.attempt}`,
        '重试模型请求',
        event.phase === 'start' ? 'running' : 'success'
      )
    }
    if (event.type === 'compaction.changed') {
      return this.upsertSystemAction(
        'context-compaction',
        '整理 Agent 上下文',
        event.phase === 'start' ? 'running' : 'success'
      )
    }
    return false
  }

  private appendReasoning(raw: string): boolean {
    const safe = sanitizeUnicodeScalars(raw)
    if (!safe) return false
    let reasoning = this.reasoning(this.turn)
    if (!reasoning) {
      reasoning = {
        id: `reasoning:${this.turn}`,
        kind: 'reasoning',
        status: 'running',
        turn: this.turn,
        text: '',
        charCount: 0,
        truncated: false
      }
      this.append(reasoning)
    }
    reasoning.charCount += Array.from(safe).length
    const available = Math.max(0, MAX_REASONING_CHARS - Array.from(reasoning.text).length)
    const visible = truncateUnicode(safe, available)
    reasoning.text += visible
    if (visible !== safe) reasoning.truncated = true
    return true
  }

  private upsertSystemAction(
    suffix: string,
    label: string,
    status: Extract<AgentMetadataActivity, { kind: 'action' }>['status']
  ): boolean {
    const id = `action:${suffix}`
    const existing = this.action(suffix)
    if (existing) {
      if (existing.status === status) return false
      existing.status = status
      return true
    }
    this.append({ id, kind: 'action', status, tool: 'runtime', label })
    return true
  }

  private reasoning(turn: number): Extract<AgentMetadataActivity, { kind: 'reasoning' }> | undefined {
    return this.activities.find(
      (activity): activity is Extract<AgentMetadataActivity, { kind: 'reasoning' }> =>
        activity.kind === 'reasoning' && activity.turn === turn
    )
  }

  private action(callId: string): Extract<AgentMetadataActivity, { kind: 'action' }> | undefined {
    return this.activities.find(
      (activity): activity is Extract<AgentMetadataActivity, { kind: 'action' }> =>
        activity.kind === 'action' && activity.id === `action:${callId}`
    )
  }

  private append(activity: AgentMetadataActivity): void {
    this.activities.push(activity)
    this.trimActionHistory()
  }

  private trimActionHistory(): void {
    while (this.activities.length > MAX_ACTIVITIES) {
      const oldestAction = this.activities.findIndex((activity) => activity.kind === 'action')
      if (oldestAction < 0) return
      this.activities.splice(oldestAction, 1)
    }
  }
}
