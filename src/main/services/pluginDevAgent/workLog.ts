import fs from 'node:fs'
import path from 'node:path'
import type {
  PluginDevAgentEvent,
  PluginDevAgentWorkLogEntry,
  PluginDevAgentWorkLogExport
} from '@shared/types'
import { getSession } from './sessionStore'
import type { PluginDevSession } from './types'

function nowIso(): string {
  return new Date().toISOString()
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
      lines.push(`[${entry.at}] user(${entry.source}): ${entry.text.slice(0, 160)}`)
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
        lines.push(`[${entry.at}] assistant: ${event.text.slice(0, 160)}`)
        break
      case 'tool_start':
        lines.push(`[${entry.at}] tool_start ${event.tool} (step ${event.step})`)
        break
      case 'tool_result':
        lines.push(
          `[${entry.at}] tool_result ${event.tool} ${event.ok ? 'ok' : 'fail'}: ${event.summary.slice(0, 160)}`
        )
        break
      case 'package_updated':
        lines.push(
          `[${entry.at}] package_updated ${event.package.name} code=${event.package.code.length}chars`
        )
        break
      case 'dry_run_updated':
        lines.push(`[${entry.at}] dry_run ${event.dryRun.ok ? 'ok' : 'fail'}`)
        break
      case 'verification_updated':
        lines.push(`[${entry.at}] verify ${event.verification.summary.slice(0, 120)}`)
        break
      case 'plugin_installed':
        lines.push(`[${entry.at}] installed ${event.descriptor.name}`)
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
          `[${entry.at}] context ~${event.stats.estimatedTokens}/${event.stats.maxTokens} tokens`
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

  const entries = [...(session.workLog ?? [])]
  return {
    schemaVersion: 1,
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
      maxSteps: session.limits.maxSteps,
      maxContextTokens: session.limits.maxContextTokens,
      testTargets: session.testTargets ?? [],
      supportedFields: session.supportedFields ?? [],
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined
    },
    timeline: buildTimeline(entries),
    entries,
    package: session.package,
    lastDryRun: session.lastDryRun,
    lastVerification: session.lastVerification
  }
}

export function writePluginDevAgentWorkLog(sessionId: string, targetPath: string): void {
  const payload = buildPluginDevAgentWorkLog(sessionId)
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf-8')
}

export function workLogDefaultFileName(session: PluginDevSession): string {
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
