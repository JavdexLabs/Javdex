import { createHash, randomUUID } from 'node:crypto'
import { normalizePluginDevAgentMaxContextTokens, normalizePluginDevAgentMaxTurns } from '@shared/settingsTypes'
import type { PluginDevAgentStartInput, PluginDevSession } from './types'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { modelManagement } from '../../agent-platform/modelManagement'
import { hasSubstantialPluginCode } from './pluginDevCodePolicy'
import {
  getPluginDevKindProfile,
  configuredRunTargets,
  normalizeTestTargets
} from '@shared/pluginDevKindProfile'

const sessions = new Map<string, PluginDevSession>()
const TERMINAL_SESSION_TTL_MS = 60 * 60 * 1000

function isDebugLikeMode(input: PluginDevAgentStartInput): boolean {
  return input.mode !== 'create'
}

export function cleanupSessions(now = Date.now()): number {
  let removed = 0
  for (const [sessionId, session] of sessions) {
    if (!session.endedAt) continue
    if (now - session.endedAt < TERMINAL_SESSION_TTL_MS) continue
    deleteSession(sessionId)
    removed += 1
  }
  return removed
}

function resolveSessionMaxSteps(input: PluginDevAgentStartInput): number {
  if (input.maxSteps !== undefined) {
    return normalizePluginDevAgentMaxTurns(input.maxSteps)
  }
  try {
    const limits = modelManagement.read().assignments.find(
      (item) => item.workloadId === 'plugin-developer'
    )?.limits
    return normalizePluginDevAgentMaxTurns(limits?.maxTurns)
  } catch {
    return normalizePluginDevAgentMaxTurns(undefined)
  }
}

function resolveSessionMaxContextTokens(input: PluginDevAgentStartInput): number {
  if (input.maxContextTokens !== undefined) {
    return normalizePluginDevAgentMaxContextTokens(input.maxContextTokens)
  }
  try {
    const limits = modelManagement.read().assignments.find(
      (item) => item.workloadId === 'plugin-developer'
    )?.limits
    return normalizePluginDevAgentMaxContextTokens(limits?.maxContextTokens)
  } catch {
    return normalizePluginDevAgentMaxContextTokens(undefined)
  }
}

function derivePluginName(input: PluginDevAgentStartInput): string {
  const explicit = input.siteName.trim()
  if (explicit) return explicit
  const rawUrl = input.siteUrl?.trim()
  if (rawUrl) {
    try {
      const host = new URL(rawUrl).hostname.replace(/^www\./i, '')
      const base = host.split('.')[0]?.trim()
      if (base) return base
    } catch {
      const match = /https?:\/\/(?:www\.)?([^/?#]+)/i.exec(rawUrl)
      const base = match?.[1]?.split('.')[0]?.trim()
      if (base) return base
    }
  }
  return getPluginDevKindProfile(input.kind).defaultPluginNameSuffix
}

export function createEmptyPackage(input: PluginDevAgentStartInput): ScraperPluginPackage {
  const profile = getPluginDevKindProfile(input.kind)
  return {
    schemaVersion: 1,
    kind: input.kind,
    name: derivePluginName(input),
    version: '1.0.0',
    description: input.description?.trim() || '',
    author: 'Plugin Dev Agent',
    homepage: input.siteUrl?.trim() || undefined,
    // A create draft deliberately starts without a declared field scope. Pi
    // fills this after inspecting the site's exact detail/profile page.
    supportedFields: input.mode === 'create' ? [] : input.supportedFields,
    code: profile.emptyPackageStub
  }
}

export function createSession(input: PluginDevAgentStartInput, sessionId: string = randomUUID()): PluginDevSession {
  cleanupSessions()
  const siteName = derivePluginName(input)
  const testTargets = normalizeTestTargets(input)
  const runTargets = configuredRunTargets(input.kind, testTargets)
  const session: PluginDevSession = {
    id: sessionId,
    status: 'running',
    mode: input.mode,
    kind: input.kind,
    siteName,
    siteUrl: input.siteUrl,
    description: input.description,
    supportedFields: input.mode === 'create' ? [] : input.supportedFields,
    testTargets,
    runTargets,
    package: input.package ?? createEmptyPackage(input),
    step: 0,
    limits: {
      maxSteps: resolveSessionMaxSteps(input),
      maxContextTokens: resolveSessionMaxContextTokens(input),
      maxHtmlChars: 20_000
    },
    cancelRequested: false,
    phase: 'working',
    totalTokens: 0,
    usageByRole: {},
    contextInputTokens: 0,
    modelTurnCount: 0,
    discoveryToolCalls: 0,
    incrementalEditOnly:
      isDebugLikeMode(input) &&
      Boolean(input.package?.code?.trim()) &&
      hasSubstantialPluginCode(input.kind, input.package!.code),
    lastUserInstruction: input.userMessage?.trim() || undefined,
    workLog: []
  }
  sessions.set(session.id, session)
  return session
}

export function getSession(sessionId: string): PluginDevSession | undefined {
  return sessions.get(sessionId)
}

export function cancelSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.cancelRequested = true
  session.status = 'cancelled'
  session.endedAt = Date.now()
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function invalidateExecution(session: PluginDevSession): void {
  session.lastExecution = undefined
  session.acceptance = undefined
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function markSessionEnded(sessionId: string, endedAt = Date.now()): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.endedAt = endedAt
}
