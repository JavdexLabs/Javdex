import fs from 'node:fs'
import path from 'node:path'
import type {
  PluginDevAgentEvent,
  PluginDevAgentSnapshot,
  PluginDevAgentWorkLogEntry,
  PluginDevAgentWorkLogExport
} from '@shared/pluginDevTypes'
import { getSession } from './sessionStore'
import type { PluginDevSession } from './types'
import { sanitizeUnicodeScalars, truncateUnicode } from '@shared/unicodeText'

function nowIso(): string {
  return new Date().toISOString()
}

function withFailedTerminalError(
  entries: PluginDevAgentWorkLogEntry[],
  input: {
    status: PluginDevSession['status']
    sessionId: string
    step: number
    message?: string
  }
): PluginDevAgentWorkLogEntry[] {
  if (
    input.status !== 'failed' ||
    entries.some((entry) =>
      entry.kind === 'event' &&
      entry.event.type === 'error' &&
      entry.event.step === input.step
    )
  ) {
    return entries
  }
  return [
    ...entries,
    {
      at: nowIso(),
      kind: 'event',
      event: {
        type: 'error',
        sessionId: input.sessionId,
        step: input.step,
        message: input.message?.trim() || '运行进入 failed 状态，但未记录具体错误原因。'
      }
    }
  ]
}

export function appendWorkLogEntry(sessionId: string, entry: PluginDevAgentWorkLogEntry): void {
  const session = getSession(sessionId)
  if (!session) return
  if (!session.workLog) session.workLog = []
  session.workLog.push(entry)
}

export function appendWorkLogEvent(sessionId: string, event: PluginDevAgentEvent): void {
  appendWorkLogEntry(sessionId, {
    at: nowIso(),
    kind: 'event',
    event
  })
}

export function appendWorkLogUserMessage(
  sessionId: string,
  text: string,
  source: 'start' | 'continue'
): void {
  const trimmed = text.trim()
  if (!trimmed) return
  appendWorkLogEntry(sessionId, {
    at: nowIso(),
    kind: 'user_message',
    sessionId,
    source,
    text: trimmed
  })
}

function buildTimeline(entries: PluginDevAgentWorkLogEntry[]): string[] {
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'user_message') {
      lines.push(`[${entry.at}] user(${entry.source}): ${truncateUnicode(entry.text, 160)}`)
      continue
    }
    const event = entry.event
    switch (event.type) {
      case 'step_start':
        lines.push(`[${entry.at}] step ${event.step}`)
        break
      case 'phase_updated':
        lines.push(`[${entry.at}] phase → ${event.phase} (step ${event.step})`)
        break
      case 'assistant_text':
        lines.push(`[${entry.at}] assistant: ${truncateUnicode(event.text, 160)}`)
        break
      case 'assistant_reasoning':
        lines.push(
          `[${entry.at}] reasoning turn=${event.turn} chars=${event.charCount}` +
          `${event.truncated ? ' truncated=true' : ''}: ${truncateUnicode(event.text, 160)}`
        )
        break
      case 'model_turn_completed':
        lines.push(
          `[${entry.at}] model_turn stop=${event.stopReason ?? 'unknown'}` +
          ` text=${event.textChars} reasoning=${event.reasoningChars} tools=${event.toolCallCount}`
        )
        break
      case 'workspace_status':
        lines.push(
          `[${entry.at}] workspace ${event.valid ? 'valid' : 'invalid'}: ${truncateUnicode(event.message, 160)}`
        )
        break
      case 'tool_start':
        lines.push(`[${entry.at}] tool_start ${event.tool} (step ${event.step})`)
        break
      case 'tool_result':
        lines.push(
          `[${entry.at}] tool_result ${event.tool} ${event.ok ? 'ok' : 'fail'}: ${truncateUnicode(event.summary, 160)}`
        )
        break
      case 'package_updated':
        lines.push(
          `[${entry.at}] package_updated ${event.package.name} code=${event.package.code.length}chars`
        )
        break
      case 'run_targets_updated':
        lines.push(`[${entry.at}] run_targets ${event.runTargets.length}`)
        break
      case 'execution_updated':
        lines.push(
          `[${entry.at}] execution ${event.execution.executionPassed ? 'passed' : 'failed'} ` +
          `scope=${event.execution.scope} cases=${event.execution.cases.length}`
        )
        break
      case 'acceptance_updated':
        lines.push(`[${entry.at}] acceptance ready=${event.outcome.ready}`)
        break
      case 'user_input_required':
        lines.push(`[${entry.at}] user_input_required ${event.request.type} request=${event.request.requestId}`)
        break
      case 'approval_required':
        lines.push(`[${entry.at}] approval_required ${event.tool} request=${event.requestId}`)
        break
      case 'waiting_user':
        lines.push(`[${entry.at}] waiting_user: ${event.reason}`)
        break
      case 'done':
        lines.push(`[${entry.at}] done success=${event.success}: ${event.summary}`)
        break
      case 'error':
        lines.push(`[${entry.at}] error: ${event.message}`)
        break
      case 'context_updated':
        lines.push(
          `[${entry.at}] context active=${event.stats.estimatedTokens}/${event.stats.maxTokens}` +
          ` cumulative=${event.stats.totalTokens} output=${event.stats.outputTokens ?? 0}` +
          ` reasoning=${event.stats.reasoningTokens ?? 0} cacheRead=${event.stats.cacheReadTokens ?? 0}`
        )
        break
      default:
        break
    }
  }
  return lines
}

export function buildPluginDevAgentWorkLog(sessionId: string): PluginDevAgentWorkLogExport {
  const session = getSession(sessionId)
  if (!session) throw new Error('会话不存在或已过期，无法导出工作日志')

  const entries = withFailedTerminalError([...(session.workLog ?? [])], {
    status: session.status,
    sessionId: session.id,
    step: session.step,
    message: session.failureMessage
  })
  return {
    schemaVersion: 7,
    kind: 'pluginDevAgentWorkLog',
    exportedAt: nowIso(),
    sessionId: session.id,
    meta: {
      mode: session.mode,
      pluginKind: session.kind,
      siteName: session.siteName,
      siteUrl: session.siteUrl,
      status: session.status,
      phase: session.phase,
      step: session.step,
      totalTokens: session.totalTokens,
      modelTurnCount: session.modelTurnCount,
      discoveryToolCalls: session.discoveryToolCalls,
      maxSteps: session.limits.maxSteps,
      maxContextTokens: session.limits.maxContextTokens,
      runTargets: structuredClone(session.runTargets),
      supportedFields: session.package.supportedFields ?? [],
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined
    },
    timeline: buildTimeline(entries),
    entries,
    package: session.package,
    lastExecution: session.lastExecution,
    acceptance: session.acceptance
  }
}

export function buildPluginDevAgentWorkLogFromSnapshot(
  snapshot: PluginDevAgentSnapshot
): PluginDevAgentWorkLogExport {
  const entries = withFailedTerminalError(structuredClone(snapshot.workLog), {
    status: snapshot.result.status,
    sessionId: snapshot.result.sessionId,
    step: snapshot.step,
    message: snapshot.result.summary
  })
  return {
    schemaVersion: 7,
    kind: 'pluginDevAgentWorkLog',
    exportedAt: nowIso(),
    sessionId: snapshot.result.sessionId,
    meta: {
      mode: snapshot.input.mode,
      pluginKind: snapshot.input.kind,
      siteName: snapshot.input.siteName,
      siteUrl: snapshot.input.siteUrl,
      status: snapshot.result.status,
      phase: snapshot.phase,
      step: snapshot.step,
      totalTokens: snapshot.totalTokens,
      modelTurnCount: snapshot.events.filter((event) => event.type === 'model_turn_completed').length,
      discoveryToolCalls: snapshot.events.filter(
        (event) => event.type === 'tool_start' && event.tool === 'browser'
      ).length,
      maxSteps: snapshot.input.maxSteps ?? 0,
      maxContextTokens: snapshot.input.maxContextTokens ?? 0,
      runTargets: structuredClone(snapshot.result.runTargets),
      supportedFields: snapshot.result.package.supportedFields ?? snapshot.input.supportedFields
    },
    timeline: buildTimeline(entries),
    entries,
    package: snapshot.result.package,
    lastExecution: snapshot.result.execution,
    acceptance: snapshot.result.acceptance
  }
}

export function writePluginDevAgentWorkLog(
  sessionId: string,
  targetPath: string,
  snapshot?: PluginDevAgentSnapshot
): void {
  const payload = snapshot
    ? buildPluginDevAgentWorkLogFromSnapshot(snapshot)
    : buildPluginDevAgentWorkLog(sessionId)
  fs.writeFileSync(
    targetPath,
    JSON.stringify(
      payload,
      (_key, value) => typeof value === 'string' ? sanitizeUnicodeScalars(value) : value,
      2
    ),
    'utf-8'
  )
}

export function workLogDefaultFileName(session: Pick<PluginDevSession, 'siteName' | 'id'>): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safeName = session.siteName
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'plugin'
  const shortId = session.id.slice(0, 8)
  return `plugin-dev-agent-${safeName}-${shortId}-${stamp}.json`
}

export function sanitizeWorkLogPath(filePath: string): string {
  return path.extname(filePath) ? filePath : `${filePath}.json`
}
