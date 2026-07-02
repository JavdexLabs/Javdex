import { randomUUID } from 'node:crypto'
import {
  normalizePluginDevAgentMaxContextTokens,
  normalizePluginDevAgentMaxSteps
} from '@shared/types'
import type { PluginDevAgentStartInput, PluginDevSession } from './types'
import type { ScraperPluginPackage } from '@shared/types'
import { getSettings } from '../../settings/settingsStore'
import { hasSubstantialPluginCode } from './pluginDevCodePolicy'
import {
  getPluginDevKindProfile,
  normalizeTestTargets
} from '@shared/pluginDevKindProfile'

const sessions = new Map<string, PluginDevSession>()
let browserLockSessionId: string | null = null
let browserLockQueue: Array<{ sessionId: string; resolve: () => void }> = []
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
    return normalizePluginDevAgentMaxSteps(input.maxSteps)
  }
  try {
    return normalizePluginDevAgentMaxSteps(getSettings().pluginDevAgentMaxSteps)
  } catch {
    return 0
  }
}

function resolveSessionMaxContextTokens(input: PluginDevAgentStartInput): number {
  if (input.maxContextTokens !== undefined) {
    return normalizePluginDevAgentMaxContextTokens(input.maxContextTokens)
  }
  try {
    return normalizePluginDevAgentMaxContextTokens(getSettings().pluginDevAgentMaxContextTokens)
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
    supportedFields:
      input.supportedFields.length > 0 ? input.supportedFields : [...profile.allSupportedFields],
    code: profile.emptyPackageStub
  }
}

export function createSession(input: PluginDevAgentStartInput): PluginDevSession {
  cleanupSessions()
  const siteName = derivePluginName(input)
  const testTargets = normalizeTestTargets(input)
  const session: PluginDevSession = {
    id: randomUUID(),
    status: 'running',
    mode: input.mode,
    kind: input.kind,
    siteName,
    siteUrl: input.siteUrl,
    description: input.description,
    supportedFields: input.supportedFields,
    testTargets,
    package: input.package ?? createEmptyPackage(input),
    pageNotes: [],
    duplicateDryRunCount: 0,
    step: 0,
    limits: {
      maxSteps: resolveSessionMaxSteps(input),
      maxContextTokens: resolveSessionMaxContextTokens(input),
      maxDuplicateDryRun: 3,
      maxHtmlChars: 8000
    },
    finishRequested: false,
    cancelRequested: false,
    phase: isDebugLikeMode(input) ? 'dry_run' : 'discover',
    totalTokens: 0,
    incrementalEditOnly:
      isDebugLikeMode(input) &&
      Boolean(input.package?.code?.trim()) &&
      hasSubstantialPluginCode(input.kind, input.package!.code),
    lastUserInstruction: input.userMessage?.trim() || undefined
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
  const queued = browserLockQueue.filter((item) => item.sessionId === sessionId)
  browserLockQueue = browserLockQueue.filter((item) => item.sessionId !== sessionId)
  for (const item of queued) item.resolve()
}

export async function withBrowserLock<T>(
  sessionId: string,
  fn: () => Promise<T>
): Promise<T> {
  await acquireBrowserLock(sessionId)
  try {
    if (getSession(sessionId)?.cancelRequested) {
      throw new Error('用户已终止，浏览器工具未执行')
    }
    return await fn()
  } finally {
    releaseBrowserLock(sessionId)
  }
}

function acquireBrowserLock(sessionId: string): Promise<void> {
  if (browserLockSessionId === null || browserLockSessionId === sessionId) {
    browserLockSessionId = sessionId
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    browserLockQueue.push({ sessionId, resolve })
  })
}

function releaseBrowserLock(sessionId: string): void {
  if (browserLockSessionId !== sessionId) return
  let next = browserLockQueue.shift()
  while (next && getSession(next.sessionId)?.cancelRequested) {
    next.resolve()
    next = browserLockQueue.shift()
  }
  if (next) {
    browserLockSessionId = next.sessionId
    next.resolve()
  } else {
    browserLockSessionId = null
  }
}

export function hashCode(code: string): string {
  let hash = 0
  for (let i = 0; i < code.length; i += 1) {
    hash = (hash * 31 + code.charCodeAt(i)) | 0
  }
  return String(hash)
}

export function invalidateVerification(session: PluginDevSession): void {
  session.lastVerification = undefined
  session.lastVerificationPromptHash = undefined
}

export function isDryRunStaleForVerify(session: PluginDevSession): boolean {
  if (!session.lastDryRun) return true
  if (session.lastDryRunCodeHash === undefined) return true
  return hashCode(session.package.code) !== session.lastDryRunCodeHash
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId)
  const queued = browserLockQueue.filter((item) => item.sessionId === sessionId)
  browserLockQueue = browserLockQueue.filter((item) => item.sessionId !== sessionId)
  for (const item of queued) item.resolve()
  if (browserLockSessionId === sessionId) {
    releaseBrowserLock(sessionId)
  }
}

export function markSessionEnded(sessionId: string, endedAt = Date.now()): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.endedAt = endedAt
}
