import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProfile } from '@shared/aiConfigurationTypes'
import type {
  PluginDevAgentEvent,
  PluginDevAgentStartInput,
  PluginDevUserResponse
} from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { AgentExecution, agentExecution } from '../../agent-platform/agentExecution'
import type { AgentRunRecord } from '../../agent-platform/agentRunStore'
import { agentRunStore } from '../../agent-platform/agentRunStore'
import { setCacheAffinityDeviceKeyForTests } from '../../agent-platform/cacheAffinity'
import { toolHost } from '../../agent-platform/toolHost'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import type {
  HostedToolBinding,
  PersistedRunConfigurationSnapshot,
  ResolvedModelAccess,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation
} from '../../agent-platform/types'
import { PluginDeveloper } from './pluginDeveloper'
import { buildPluginDevAgentWorkLogFromSnapshot } from './workLog'
import {
  createSession,
  deleteSession
} from './sessionStore'
import type { PluginDevSession } from './types'
import { pluginWorkspace } from './pluginWorkspace'
import { pluginArtifactHash } from './pluginArtifact'
import { PLUGIN_RUNTIME_VERSION, pluginRunTargetFingerprint } from './pluginExecution'
import { pluginRunAcceptance } from './pluginRunAcceptance'

const input: PluginDevAgentStartInput = {
  mode: 'create',
  kind: 'video',
  siteName: 'Lifecycle Test',
  siteUrl: 'https://example.test',
  supportedFields: ['title'],
  testTargets: ['ABC-123'],
  userMessage: '创建插件',
  maxSteps: 4,
  maxContextTokens: 8_000
}

const packageValue: ScraperPluginPackage = {
  schemaVersion: 1,
  kind: 'video',
  name: 'Lifecycle Test',
  version: '1.0.0',
  description: '',
  author: 'Test',
  homepage: 'https://example.test',
  supportedFields: ['title'],
  code: 'async function scrape(ctx) { return { title: "Example" }; }'
}

function profile(): AgentProfile {
  return {
    id: 'profile:plugin-developer:test',
    name: 'Plugin Developer Test',
    definitionId: 'plugin-developer',
    routes: { primary: 'primary', verifier: 'verifier', summarizer: 'summarizer' },
    toolPackRefs: [],
    capabilityGrants: [],
    approvalRequiredEffects: ['install'],
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 }
  }
}

function access(role: string, routeRevision = `route:${role}`): ResolvedModelAccess {
  return {
    credentialRef: `credential:${role}`,
    model: {
      providerId: 'test',
      modelId: role,
      name: role,
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      contextWindow: 16_000,
      maxTokens: 2_000,
      reasoning: false
    },
    routeRevision,
    preset: {
      thinkingLevel: 'minimal',
      maxTokens: 2_000,
      timeoutMs: 1_000,
      cacheRetention: role === 'verifier' ? 'short' : 'none'
    },
    cacheCompatibility: {
      supportsPromptCache: false,
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: false,
      evidence: { source: 'manual', checkedAt: '2026-08-20T00:00:00.000Z' }
    },
    getCredentialLease: async () => { throw new Error('not used') }
  }
}

function frozenSnapshot(inputProfile = profile()): PersistedRunConfigurationSnapshot {
  const primary = access('primary')
  const prompt = 'stable plugin developer prompt'
  return {
    revision: 'configuration:legacy',
    definitionId: 'plugin-developer',
    profile: inputProfile,
    model: {
      credentialRef: primary.credentialRef,
      descriptor: primary.model,
      routeRevision: primary.routeRevision,
      preset: primary.preset,
      cacheCompatibility: primary.cacheCompatibility
    },
    cache: {
      primaryAffinityId: 'primary-affinity',
      verifierAffinityId: 'legacy-verifier-affinity',
      summarizerAffinityId: 'summarizer-affinity',
      retention: { primary: 'none', verifier: 'none', summarizer: 'none' }
    },
    systemPrompt: {
      text: prompt,
      sha256: createHash('sha256').update(prompt).digest('hex')
    },
    tools: [],
    settings: {
      compaction: inputProfile.compaction,
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
      maxTurns: 4
    }
  }
}

interface TestActiveRun {
  input: PluginDevAgentStartInput
  session: PluginDevSession
  tools: readonly HostedToolBinding[]
  emit?: (event: PluginDevAgentEvent) => void
  assistantText: string
  reasoningText: string
  reasoningTruncated: boolean
  pendingAssistantDelta: string
  pendingReasoningDelta: string
  streamFlushTimer?: ReturnType<typeof setTimeout>
  summary: string
  lastAssistantStopReason?: string
  waiter?: { resolve: (result: unknown) => void }
}

interface TestablePluginDeveloper {
  active: Map<string, TestActiveRun>
  emitDomainEvent(active: TestActiveRun, event: PluginDevAgentEvent): void
  restoreSession(runId: string, state: Record<string, unknown>): PluginDevSession
  materializeWorkspace(session: PluginDevSession, input: PluginDevAgentStartInput): void
  runtimeNotify(active: TestActiveRun, event: RuntimeObservation): void
  runtimeProject(
    active: TestActiveRun,
    event: RuntimeDurableObservation
  ): { state: Record<string, unknown>; status?: string }
  restoredConfiguration(
    runId: string,
    snapshot: PersistedRunConfigurationSnapshot,
    session: PluginDevSession,
    emit: () => void
  ): ResolvedRunConfiguration
  activatePersistedRun(runId: string): Promise<TestActiveRun>
  applyUserResponse(
    session: PluginDevSession,
    response: PluginDevUserResponse
  ): { prompt: string; transcriptText: string; updatesInstruction: boolean }
}

function testable(developer: PluginDeveloper): TestablePluginDeveloper {
  return developer as unknown as TestablePluginDeveloper
}

function replaceMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K]
): () => void {
  const mutable = target as unknown as Record<PropertyKey, unknown>
  const original = mutable[key]
  mutable[key] = replacement
  return () => { mutable[key] = original }
}

function activeRun(session: PluginDevSession): TestActiveRun {
  return {
    input: structuredClone(input),
    session,
    tools: [],
    assistantText: '',
    reasoningText: '',
    reasoningTruncated: false,
    pendingAssistantDelta: '',
    pendingReasoningDelta: '',
    summary: 'waiting'
  }
}

function markMechanicallyReady(session: PluginDevSession, directory: string): void {
  session.status = 'waiting_user'
  session.phase = 'ready'
  session.lastExecution = {
    runtimeVersion: PLUGIN_RUNTIME_VERSION,
    artifactHash: pluginArtifactHash(session.package),
    targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
    scope: 'all',
    targets: structuredClone(session.runTargets),
    cases: session.runTargets.map((target) => ({
      target,
      pluginResult: { code: 'ABC-123', title: 'Example' },
      effectiveResult: { code: 'ABC-123', title: 'Example' },
      manifestCoverage: {
        returnedFieldIds: ['title'],
        undeclaredReturnedFieldIds: [],
        runtimeOnlyKeys: []
      },
      logs: [],
      runtimeAccepted: true
    })),
    executionPassed: true,
    reportPath: path.join(directory, '.javdex/reports/pass.json')
  }
  session.acceptance = pluginRunAcceptance.evaluate({
    package: session.package,
    targets: session.runTargets,
    execution: session.lastExecution
  }).outcome
  pluginWorkspace.recordLatestDryRun(directory, {
    schemaVersion: 1,
    status: 'completed',
    artifactHash: session.lastExecution.artifactHash,
    reportPath: session.lastExecution.reportPath,
    scope: session.lastExecution.scope,
    runtimeVersion: session.lastExecution.runtimeVersion,
    targetFingerprint: session.lastExecution.targetFingerprint,
    executionPassed: session.lastExecution.executionPassed,
    cases: session.lastExecution.cases.map((item) => ({
      runtimeInput: item.target,
      runtimeAccepted: item.runtimeAccepted,
      pluginResult: item.pluginResult,
      effectiveResult: item.effectiveResult,
      manifestCoverage: item.manifestCoverage,
      unrecognizedResultKeys: item.unrecognizedResultKeys ?? [],
      error: item.error
    })),
    currentAcceptance: { installReady: true, reasons: [] }
  })
}

let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = '/tmp/javdex-plugin-developer-lifecycle-test'
})

afterEach(() => {
  setCacheAffinityDeviceKeyForTests(null)
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
})

describe('PluginDeveloper approval and lifecycle stability', { concurrency: false }, () => {
  it('restores a legacy run with newly-invalid field ids as a repairable workspace', () => {
    const developer = new PluginDeveloper()
    const runId = 'legacy-invalid-supported-fields'
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      runId
    )
    const directory = path.join(
      process.env.JAVDEX_TEST_USER_DATA!,
      'agent-sessions',
      runId
    )
    const workspace = pluginWorkspace.open({
      directory,
      task: input,
      package: packageValue
    })
    const manifest = JSON.parse(fs.readFileSync(workspace.files.manifest, 'utf8'))
    manifest.supportedFields = ['title', 'coverUrl', 'durationSeconds', 'sourceUrl']
    fs.writeFileSync(workspace.files.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    try {
      assert.doesNotThrow(() => testable(developer).materializeWorkspace(session, input))
      assert.match(session.workspaceDraftError ?? '', /coverUrl.*cover/)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(workspace.files.manifest, 'utf8')).supportedFields,
        ['title', 'coverUrl', 'durationSeconds', 'sourceUrl']
      )
      assert.deepEqual(session.package.supportedFields, ['title'])
    } finally {
      deleteSession(runId)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('clears every durable plugin-development history without touching other Agent use cases', async () => {
    const developer = new PluginDeveloper()
    const records = [
      { id: 'plugin-history-new', useCase: 'plugin-developer' },
      { id: 'plugin-history-old', useCase: 'plugin-developer' },
      { id: 'library-history', useCase: 'library-curator' }
    ].map((item) => ({
      ...item,
      status: 'settled' as const,
      configRevision: 'test',
      configSnapshot: frozenSnapshot(),
      recoveryGeneration: 0,
      productState: {},
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z'
    })) satisfies AgentRunRecord[]
    const closed: string[] = []
    const discarded: string[] = []
    const historyRoot = path.join(process.env.JAVDEX_TEST_USER_DATA!, 'agent-sessions')
    for (const id of ['plugin-history-new', 'plugin-history-old', 'library-history']) {
      fs.mkdirSync(path.join(historyRoot, id), { recursive: true })
      fs.writeFileSync(path.join(historyRoot, id, 'history.txt'), id, 'utf8')
    }
    const restoreList = replaceMethod(
      agentRunStore,
      'iterateCleanupRunIds',
      (function* () { yield* records.filter((record) => record.useCase === 'plugin-developer').map((record) => record.id) }) as typeof agentRunStore.iterateCleanupRunIds
    )
    const restoreCleanupPending = replaceMethod(agentRunStore, 'setResourceCleanupPending', () => {})
    const restoreClose = replaceMethod(agentExecution, 'closeRun', (async (runId) => {
      closed.push(runId)
    }) as typeof agentExecution.closeRun)
    const restoreDiscard = replaceMethod(toolHost, 'discardApprovals', ((runId) => {
      discarded.push(runId)
    }) as typeof toolHost.discardApprovals)
    const restoreDispose = replaceMethod(
      toolHost,
      'disposeRun',
      (() => undefined) as typeof toolHost.disposeRun
    )
    try {
      const clearHistory = (developer as unknown as {
        clearHistory(): Promise<number>
      }).clearHistory
      const count = await clearHistory.call(developer)

      assert.equal(count, 2)
      assert.deepEqual(closed.sort(), ['plugin-history-new', 'plugin-history-old'])
      assert.deepEqual(discarded.sort(), ['plugin-history-new', 'plugin-history-old'])
      assert.equal(fs.existsSync(path.join(historyRoot, 'plugin-history-new')), false)
      assert.equal(fs.existsSync(path.join(historyRoot, 'plugin-history-old')), false)
      assert.equal(fs.existsSync(path.join(historyRoot, 'library-history')), true)
    } finally {
      restoreDispose()
      restoreDiscard()
      restoreClose()
      restoreCleanupPending()
      restoreList()
      fs.rmSync(process.env.JAVDEX_TEST_USER_DATA!, { recursive: true, force: true })
    }
  })

  it('refuses to clear history while a plugin-development operation is running', async () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'plugin-history-running'
    )
    testable(developer).active.set(session.id, activeRun(session))
    let closeCalls = 0
    const restoreList = replaceMethod(
      agentRunStore,
      'iterateCleanupRunIds',
      (function* () {}) as typeof agentRunStore.iterateCleanupRunIds
    )
    const restoreCleanupPending = replaceMethod(agentRunStore, 'setResourceCleanupPending', () => {})
    const restoreClose = replaceMethod(agentExecution, 'closeRun', (async () => {
      closeCalls += 1
    }) as typeof agentExecution.closeRun)
    try {
      await assert.rejects(() => developer.clearHistory(), /正在运行或收尾/)
      assert.equal(closeCalls, 0)
      assert.equal(testable(developer).active.has(session.id), true)
    } finally {
      restoreClose()
      restoreCleanupPending()
      restoreList()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
    }
  })

  it('discards unrecoverable plugin-development history without touching recoverable runs', async () => {
    const developer = new PluginDeveloper()
    const records = [
      { id: 'plugin-settled', useCase: 'plugin-developer', status: 'settled' as const },
      { id: 'plugin-failed', useCase: 'plugin-developer', status: 'failed' as const },
      { id: 'plugin-cancelled', useCase: 'plugin-developer', status: 'cancelled' as const },
      { id: 'plugin-waiting', useCase: 'plugin-developer', status: 'waiting_user' as const },
      { id: 'library-history', useCase: 'library-curator', status: 'settled' as const }
    ].map((item) => ({
      ...item,
      configRevision: 'test',
      configSnapshot: frozenSnapshot(),
      recoveryGeneration: 0,
      productState: {},
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z'
    })) satisfies AgentRunRecord[]
    const closed: string[] = []
    const historyRoot = path.join(process.env.JAVDEX_TEST_USER_DATA!, 'agent-sessions')
    for (const id of [
      'plugin-settled',
      'plugin-failed',
      'plugin-cancelled',
      'plugin-waiting',
      'plugin-running',
      'library-history'
    ]) {
      fs.mkdirSync(path.join(historyRoot, id), { recursive: true })
      fs.writeFileSync(path.join(historyRoot, id, 'history.txt'), id, 'utf8')
    }
    const waiting = createSession({ ...input, package: structuredClone(packageValue) }, 'plugin-waiting')
    waiting.status = 'waiting_user'
    testable(developer).active.set(waiting.id, activeRun(waiting))
    const running = createSession({ ...input, package: structuredClone(packageValue) }, 'plugin-running')
    testable(developer).active.set(running.id, activeRun(running))
    const restoreList = replaceMethod(
      agentRunStore,
      'iterateCleanupRunIds',
      (function* () { yield* records.filter((record) => record.useCase === 'plugin-developer').map((record) => record.id) }) as typeof agentRunStore.iterateCleanupRunIds
    )
    const restoreGet = replaceMethod(
      agentRunStore,
      'getRunStatus',
      ((runId: string) => records.find((record) => record.id === runId)?.status ?? null) as typeof agentRunStore.getRunStatus
    )
    const restoreCleanupPending = replaceMethod(agentRunStore, 'setResourceCleanupPending', () => {})
    const restoreClose = replaceMethod(agentExecution, 'closeRun', (async (runId) => {
      closed.push(runId)
    }) as typeof agentExecution.closeRun)
    const restoreDiscard = replaceMethod(toolHost, 'discardApprovals', (() => undefined) as typeof toolHost.discardApprovals)
    const restoreDispose = replaceMethod(toolHost, 'disposeRun', (() => undefined) as typeof toolHost.disposeRun)
    try {
      const count = await developer.discardUnrecoverableSessions()

      assert.equal(count, 3)
      assert.deepEqual(closed.sort(), ['plugin-cancelled', 'plugin-failed', 'plugin-settled'])
      assert.equal(testable(developer).active.has(waiting.id), true)
      assert.equal(testable(developer).active.has(running.id), true)
      assert.equal(fs.existsSync(path.join(historyRoot, 'plugin-settled')), false)
      assert.equal(fs.existsSync(path.join(historyRoot, 'plugin-waiting')), true)
      assert.equal(fs.existsSync(path.join(historyRoot, 'plugin-running')), true)
      assert.equal(fs.existsSync(path.join(historyRoot, 'library-history')), true)
    } finally {
      restoreDispose()
      restoreDiscard()
      restoreClose()
      restoreCleanupPending()
      restoreGet()
      restoreList()
      testable(developer).active.delete(waiting.id)
      testable(developer).active.delete(running.id)
      deleteSession(waiting.id)
      deleteSession(running.id)
      fs.rmSync(process.env.JAVDEX_TEST_USER_DATA!, { recursive: true, force: true })
    }
  })

  it('waits for a slow terminal release before an immediate continuation reopens the run', async () => {
    const developer = new PluginDeveloper()
    const runId = 'plugin-slow-terminal-release'
    const terminalSession = createSession(
      { ...input, package: structuredClone(packageValue) },
      runId
    )
    terminalSession.status = 'completed'
    terminalSession.phase = 'ready'
    const terminalActive = activeRun(terminalSession)
    testable(developer).active.set(runId, terminalActive)

    let finishRelease: (() => void) | undefined
    const slowRelease = new Promise<void>((resolve) => { finishRelease = resolve })
    let releaseCalls = 0
    let discardCalls = 0
    let activationCalls = 0
    let resumedActive: TestActiveRun | undefined
    const restoreRelease = replaceMethod(agentExecution, 'releaseRun', (async () => {
      releaseCalls += 1
      await slowRelease
    }) as typeof agentExecution.releaseRun)
    const restoreDiscard = replaceMethod(toolHost, 'discardApprovals', (() => {
      discardCalls += 1
    }) as typeof toolHost.discardApprovals)
    const restoreDispose = replaceMethod(toolHost, 'disposeRun', (() => undefined) as typeof toolHost.disposeRun)
    const restoreActivate = replaceMethod(testable(developer), 'activatePersistedRun', (async () => {
      activationCalls += 1
      const resumedSession = createSession(
        { ...input, package: structuredClone(packageValue) },
        runId
      )
      resumedSession.status = 'waiting_user'
      resumedSession.phase = 'waiting_user'
      resumedActive = activeRun(resumedSession)
      testable(developer).active.set(runId, resumedActive)
      return resumedActive
    }) as TestablePluginDeveloper['activatePersistedRun'])
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    const restoreUpdate = replaceMethod(
      agentRunStore,
      'updateProductState',
      (() => undefined) as typeof agentRunStore.updateProductState
    )
    const restoreDispatch = replaceMethod(agentExecution, 'dispatch', (async () => {
      assert.ok(resumedActive)
      resumedActive.session.status = 'waiting_user'
      resumedActive.session.phase = 'waiting_user'
      testable(developer).runtimeProject(resumedActive, {
        type: 'agent.settled',
        acceptedCommandIds: ['operation-after-release']
      })
      return { operationId: 'operation-after-release', accepted: true, duplicate: false }
    }) as typeof agentExecution.dispatch)
    try {
      testable(developer).runtimeProject(terminalActive, {
        type: 'agent.settled',
        acceptedCommandIds: ['terminal-operation']
      })
      testable(developer).runtimeProject(terminalActive, {
        type: 'agent.settled',
        acceptedCommandIds: ['duplicate-terminal-operation']
      })
      assert.equal(releaseCalls, 1)
      assert.equal(discardCalls, 1, 'approval capabilities are cleared before slow disposal')

      const continuation = developer.message({ sessionId: runId, text: '继续完善插件' })
      await Promise.resolve()
      assert.equal(activationCalls, 0, 'lazy reopen must not overlap the old runtime disposal')

      finishRelease?.()
      const result = await continuation
      assert.equal(activationCalls, 1)
      assert.equal(result.status, 'waiting_user')
      assert.equal(releaseCalls, 1)
    } finally {
      finishRelease?.()
      restoreDispatch()
      restoreUpdate()
      restoreGetRun()
      restoreActivate()
      restoreDispose()
      restoreDiscard()
      restoreRelease()
      testable(developer).active.delete(runId)
      deleteSession(runId)
    }
  })

  it('materializes a terminal workspace before lazy continuation projects native file tools', async () => {
    const developer = new PluginDeveloper()
    const runId = 'plugin-terminal-workspace-resume'
    const debugInput: PluginDevAgentStartInput = {
      ...input,
      mode: 'debug',
      package: structuredClone(packageValue)
    }
    const productState = {
      schemaVersion: 1,
      input: debugInput,
      status: 'completed',
      phase: 'ready',
      step: 1,
      totalTokens: 0,
      modelTurnCount: 0,
      discoveryToolCalls: 0,
      runTargets: [{ kind: 'video' as const, code: 'ABC-123' }],
      package: structuredClone(packageValue),
      summary: 'ready',
      workLog: []
    }
    const record = {
      id: runId,
      useCase: 'plugin-developer',
      status: 'settled',
      configRevision: 'test',
      configSnapshot: frozenSnapshot(),
      recoveryGeneration: 0,
      productState,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z'
    } satisfies AgentRunRecord<typeof productState>
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => record) as typeof agentRunStore.getRun
    )
    const restoreUpdate = replaceMethod(
      agentRunStore,
      'updateProductState',
      (() => undefined) as typeof agentRunStore.updateProductState
    )
    let journalSeq = 0
    const restoreCursor = replaceMethod(agentRunStore, 'getProductJournalCursor', () => journalSeq)
    const restoreTransition = replaceMethod(agentRunStore, 'updateProductStateFrom', ((
      _runId: string, _status: string, build: (current: AgentRunRecord) => Record<string, unknown>
    ) => {
      const next = build(record)
      record.productState = next as typeof productState
      return next
    }) as typeof agentRunStore.updateProductStateFrom)
    const restoreAppend = replaceMethod(
      agentRunStore,
      'appendProductEvent',
      (() => ++journalSeq) as typeof agentRunStore.appendProductEvent
    )
    const restoreOpen = replaceMethod(
      agentExecution,
      'openRun',
      (async () => ({ runId, source: 'restored' })) as typeof agentExecution.openRun
    )
    const restoreConfiguration = replaceMethod(
      testable(developer),
      'restoredConfiguration',
      (() => ({}) as ResolvedRunConfiguration) as TestablePluginDeveloper['restoredConfiguration']
    )
    try {
      const active = await testable(developer).activatePersistedRun(runId)
      assert.ok(active.session.workspaceDirectory, 'lazy activation must bind the durable workspace')

      const editedCode = 'async function scrape() { return { title: "Edited" }; }\n'
      fs.writeFileSync(path.join(active.session.workspaceDirectory, 'index.js'), editedCode, 'utf8')

      testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'native-read', toolName: 'read', ok: true, summary: 'read index.js' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'read-hash' }
      })
      assert.doesNotMatch(active.session.package.code, /Edited/, 'read must not rescan the draft')

      const projection = testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'native-edit', toolName: 'edit', ok: true, summary: 'updated index.js' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'edit-hash' }
      })
      assert.notEqual(projection.state.status, 'failed')
      assert.match(active.session.package.code, /Edited/)
    } finally {
      restoreConfiguration()
      restoreOpen()
      restoreAppend()
      restoreTransition()
      restoreCursor()
      restoreUpdate()
      restoreGetRun()
      testable(developer).active.delete(runId)
      deleteSession(runId)
      fs.rmSync(process.env.JAVDEX_TEST_USER_DATA!, { recursive: true, force: true })
    }
  })

  it('projects Pi native file tools into the durable product timeline', () => {
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'native-tool-timeline')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-native-tool-timeline-'))
    session.workspaceDirectory = directory
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      testable(developer).runtimeProject(active, {
        type: 'tool.started',
        call: { callId: 'native-1', toolName: 'edit', argsDigest: 'digest-1' }
      })
      testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'native-1', toolName: 'edit', ok: true, summary: 'updated index.js' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'hash' }
      })
      assert.deepEqual(events.map((event) => event.type), ['tool_start', 'tool_result'])
      assert.equal(events[0]?.type === 'tool_start' ? events[0].tool : '', 'edit')
    } finally {
      restoreGetRun()
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records exactly one domain error when a runtime fault transitions the run to failed', () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'runtime-fault-audit'
    )
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      testable(developer).runtimeProject(active, {
        type: 'runtime.fault',
        category: 'runtime-failed',
        message: 'provider stream disconnected'
      })
      testable(developer).runtimeProject(active, {
        type: 'runtime.fault',
        category: 'runtime-failed',
        message: 'provider stream disconnected'
      })

      assert.equal(session.status, 'failed')
      assert.equal(session.failureMessage, 'provider stream disconnected')
      assert.equal(events.filter((event) => event.type === 'error').length, 1)
    } finally {
      restoreGetRun()
      deleteSession(session.id)
    }
  })

  it('surfaces an unpersistable runtime fault and resolves the active operation', () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'runtime-persistence-fault'
    )
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    let resolvedStatus = ''
    active.waiter = {
      resolve: (result) => { resolvedStatus = (result as { status: string }).status }
    }

    try {
      testable(developer).runtimeNotify(active, {
        type: 'runtime.fault',
        category: 'persistence-failed',
        message: 'UNIQUE constraint failed: agent_product_journal'
      })
      testable(developer).runtimeNotify(active, {
        type: 'runtime.fault',
        category: 'persistence-failed',
        message: 'UNIQUE constraint failed: agent_product_journal'
      })

      assert.equal(session.status, 'failed')
      assert.equal(session.failureMessage, 'UNIQUE constraint failed: agent_product_journal')
      assert.equal(resolvedStatus, 'failed')
      assert.equal(active.waiter, undefined)
      assert.equal(events.filter((event) => event.type === 'error').length, 1)
    } finally {
      deleteSession(session.id)
    }
  })

  it('publishes the reduced active context immediately after Pi compaction', () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'compaction-context-sync'
    )
    session.contextInputTokens = 7_200
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      testable(developer).runtimeProject(active, {
        type: 'compaction.changed',
        phase: 'end',
        result: {
          reason: 'threshold',
          tokensBefore: 7_200,
          tokensAfter: 1_600
        }
      } as RuntimeDurableObservation)

      assert.equal(session.contextInputTokens, 1_600)
      const context = events.find(
        (event): event is Extract<PluginDevAgentEvent, { type: 'context_updated' }> =>
          event.type === 'context_updated'
      )
      assert.ok(context)
      assert.equal(context.stats.estimatedTokens, 1_600)
    } finally {
      restoreGetRun()
      deleteSession(session.id)
    }
  })

  it('keeps a transient invalid workspace recoverable and resyncs after a valid rewrite', () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'recover-invalid-workspace'
    )
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-recover-invalid-workspace-'))
    session.workspaceDirectory = directory
    const workspace = pluginWorkspace.open({ directory, task: input, package: packageValue })
    session.package = workspace.package
    const lastValidPackage = structuredClone(session.package)
    const validManifest = fs.readFileSync(workspace.files.manifest, 'utf8')
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      fs.writeFileSync(workspace.files.manifest, '{ broken', 'utf8')
      const invalidProjection = testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'invalid-edit', toolName: 'edit', ok: true, summary: 'edited plugin.json' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'invalid-edit' }
      })

      assert.equal(session.status, 'running')
      assert.equal(invalidProjection.status, 'running')
      assert.deepEqual(session.package, lastValidPackage)
      assert.match(session.workspaceDraftError ?? '', /plugin\.json/)

      fs.writeFileSync(workspace.files.manifest, validManifest, 'utf8')
      const repairedProjection = testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'repair-write', toolName: 'write', ok: true, summary: 'rewrote plugin.json' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'repair-write' }
      })

      assert.equal(session.status, 'running')
      assert.equal(repairedProjection.status, 'running')
      assert.equal(session.workspaceDraftError, undefined)
      assert.equal(
        events.filter((event) => event.type === 'workspace_status').length,
        2
      )
    } finally {
      restoreGetRun()
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('streams provider reasoning and answer while persisting each only once per completed turn', async () => {
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'reasoning-timeline')
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      testable(developer).runtimeNotify(active, {
        type: 'reasoning.delta',
        text: '先确认目标页，'
      })
      testable(developer).runtimeNotify(active, {
        type: 'reasoning.delta',
        text: '然后直接编写插件。'
      })
      testable(developer).runtimeNotify(active, {
        type: 'assistant.delta',
        text: '我会直接实现。'
      })
      await new Promise((resolve) => setTimeout(resolve, 70))

      assert.deepEqual(events.map((event) => event.type), [
        'assistant_reasoning_delta',
        'assistant_text_delta'
      ])
      assert.equal(session.workLog?.length, 0, 'ephemeral stream deltas must not enter the work log')

      testable(developer).runtimeProject(active, {
        type: 'message.completed',
        audit: {
          role: 'assistant',
          textPreview: '我会直接实现。',
          contentHash: 'reasoning-message',
          stopReason: 'stop',
          textChars: 7,
          reasoningChars: 17,
          toolCallCount: 0,
          contentTypes: ['thinking']
        },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'reasoning-recovery' }
      })

      assert.deepEqual(events.map((event) => event.type), [
        'assistant_reasoning_delta',
        'assistant_text_delta',
        'assistant_reasoning',
        'model_turn_completed',
        'assistant_text'
      ])
      const reasoning = events[2]
      assert.equal(reasoning?.type, 'assistant_reasoning')
      if (reasoning?.type === 'assistant_reasoning') {
        assert.equal(reasoning.turn, 1)
        assert.equal(reasoning.text, '先确认目标页，然后直接编写插件。')
        assert.equal(reasoning.charCount, 17)
        assert.equal(reasoning.truncated, false)
      }
      assert.equal(
        session.workLog?.filter(
          (entry) => entry.kind === 'event' && entry.event.type === 'assistant_reasoning'
        ).length,
        1
      )
      assert.equal(
        session.workLog?.filter(
          (entry) => entry.kind === 'event' && entry.event.type === 'assistant_text'
        ).length,
        1
      )
      assert.equal(
        session.workLog?.some(
          (entry) => entry.kind === 'event' && (
            entry.event.type === 'assistant_reasoning_delta' ||
            entry.event.type === 'assistant_text_delta'
          )
        ),
        false
      )
    } finally {
      restoreGetRun()
      deleteSession(session.id)
    }
  })

  it('bounds one displayed reasoning block and reports the original character count', () => {
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'reasoning-limit')
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      testable(developer).runtimeNotify(active, {
        type: 'reasoning.delta',
        text: 'r'.repeat(64_010)
      })
      testable(developer).runtimeProject(active, {
        type: 'message.completed',
        audit: {
          role: 'assistant',
          textPreview: '',
          contentHash: 'reasoning-limit-message',
          stopReason: 'length',
          textChars: 0,
          reasoningChars: 64_010,
          toolCallCount: 0,
          contentTypes: ['thinking']
        },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'reasoning-limit-recovery' }
      })

      const reasoning = events.find(
        (event): event is Extract<PluginDevAgentEvent, { type: 'assistant_reasoning' }> =>
          event.type === 'assistant_reasoning'
      )
      assert.ok(reasoning)
      assert.equal(reasoning.text.length, 64_000)
      assert.equal(reasoning.charCount, 64_010)
      assert.equal(reasoning.truncated, true)
    } finally {
      restoreGetRun()
      deleteSession(session.id)
    }
  })

  it('revokes an approved permit when Pi rejects the approval continuation', async () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'plugin-approval-dispatch-rejected'
    )
    session.status = 'waiting_user'
    const active = activeRun(session)
    testable(developer).active.set(session.id, active)
    let approved = 0
    let revoked = 0
    let discarded = 0
    const restorePending = replaceMethod(toolHost, 'pendingApprovals', (() => [{
      requestId: 'approval-dispatch-rejected',
      callId: 'install-call',
      toolName: 'plugin_install',
      argsDigest: 'digest'
    }]) as typeof toolHost.pendingApprovals)
    const restoreApprove = replaceMethod(toolHost, 'approve', (() => { approved += 1 }) as typeof toolHost.approve)
    const restoreRevoke = replaceMethod(toolHost, 'revokeApproval', (() => {
      revoked += 1
      return true
    }) as typeof toolHost.revokeApproval)
    const restoreDiscard = replaceMethod(toolHost, 'discardApprovals', (() => {
      discarded += 1
    }) as typeof toolHost.discardApprovals)
    const restoreDispose = replaceMethod(toolHost, 'disposeRun', (() => undefined) as typeof toolHost.disposeRun)
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    const restoreUpdate = replaceMethod(
      agentRunStore,
      'updateProductState',
      (() => undefined) as typeof agentRunStore.updateProductState
    )
    const restoreDispatch = replaceMethod(agentExecution, 'dispatch', (async () => ({
      operationId: 'rejected-operation', accepted: false, duplicate: false
    })) as typeof agentExecution.dispatch)
    const restoreRelease = replaceMethod(agentExecution, 'releaseRun', (async () => undefined) as typeof agentExecution.releaseRun)
    try {
      await assert.rejects(() => developer.message({
        sessionId: session.id,
        text: '批准安装',
        approvalDecision: { requestId: 'approval-dispatch-rejected', decision: 'approve' }
      }), /拒绝了 prompt/)
      assert.equal(approved, 1)
      assert.equal(revoked, 1)
      assert.equal(discarded, 1)
      assert.equal(testable(developer).active.has(session.id), false)
    } finally {
      restoreRelease()
      restoreDispatch()
      restoreUpdate()
      restoreGetRun()
      restoreDispose()
      restoreDiscard()
      restoreRevoke()
      restoreApprove()
      restorePending()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
    }
  })

  it('does not consume an approval while the operation that emitted waiting_user is still settling', async () => {
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'plugin-waiter-guard')
    session.status = 'waiting_user'
    const active = activeRun(session)
    active.waiter = { resolve: () => undefined }
    testable(developer).active.set(session.id, active)
    let pendingReads = 0
    let approvals = 0
    const restorePending = replaceMethod(toolHost, 'pendingApprovals', (() => {
      pendingReads += 1
      return [{ requestId: 'approval-1', callId: 'call-1', toolName: 'plugin_install', argsDigest: 'digest' }]
    }) as typeof toolHost.pendingApprovals)
    const restoreApprove = replaceMethod(toolHost, 'approve', (() => { approvals += 1 }) as typeof toolHost.approve)
    try {
      await assert.rejects(
        () => developer.message({
          sessionId: session.id,
          text: '批准安装',
          approvalDecision: { requestId: 'approval-1', decision: 'approve' }
        }),
        /当前操作仍在收尾/
      )
      assert.equal(pendingReads, 0)
      assert.equal(approvals, 0)
    } finally {
      restoreApprove()
      restorePending()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
    }
  })

  it('binds a typed choice to the exact request without treating it as user feedback', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-user-response-'))
    initDatabaseAtPath(path.join(directory, 'test.sqlite'))
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'typed-field-response')
    session.workspaceDirectory = path.join(directory, 'workspace')
    pluginWorkspace.open({
      directory: session.workspaceDirectory,
      task: input,
      package: packageValue
    })
    session.lastUserInstruction = '原始缺陷反馈'
    session.pendingUserRequest = {
      requestId: 'choice-1',
      type: 'choice',
      prompt: '请选择字段',
      evidenceRefs: ['.javdex/browser/page.json'],
      options: [
        { id: '1', label: '发行商', description: '用户确认' },
        { id: '2', label: '制作商', description: '用户确认' }
      ]
    }
    try {
      assert.throws(() => testable(developer).applyUserResponse(session, {
        requestId: 'choice-other',
        type: 'choice',
        optionId: '1'
      }), /已过期|属于其他会话/)
      const result = testable(developer).applyUserResponse(session, {
        requestId: 'choice-1',
        type: 'choice',
        optionId: '1'
      })
      assert.equal(result.updatesInstruction, false)
      assert.match(result.prompt, /问题：请选择字段/)
      assert.match(result.prompt, /发行商/)
      assert.match(result.prompt, /选项说明：用户确认/)
      assert.match(result.prompt, /关联证据：\.javdex\/browser\/page\.json/)
      assert.match(result.prompt, /“获取证据”阶段重新评估当前 blocker/)
      assert.match(result.prompt, /不会自动结束其他歧义/)
      assert.match(result.prompt, /不会自动要求修改或 dry-run/)
      assert.doesNotMatch(result.prompt, /dev-notes\.md|index\.js|plugin\.json|plugin_dry_run|探索阶段结束/)
      const decisions = JSON.parse(fs.readFileSync(
        path.join(session.workspaceDirectory!, '.javdex', 'decisions.json'),
        'utf8'
      )) as Array<Record<string, unknown>>
      assert.equal(decisions.length, 1)
      assert.deepEqual(
        {
          requestId: decisions[0]?.requestId,
          question: decisions[0]?.question,
          selectedOption: decisions[0]?.selectedOption,
          evidenceRefs: decisions[0]?.evidenceRefs
        },
        {
          requestId: 'choice-1',
          question: '请选择字段',
          selectedOption: { id: '1', label: '发行商', description: '用户确认' },
          evidenceRefs: ['.javdex/browser/page.json']
        }
      )
      assert.equal(session.lastUserInstruction, '原始缺陷反馈')
      assert.equal(session.pendingUserRequest, undefined)
      assert.throws(() => testable(developer).applyUserResponse(session, {
        requestId: 'choice-1', type: 'choice', optionId: '1'
      }), /没有待处理/)
    } finally {
      deleteSession(session.id)
      closeDatabase()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resumes a typed browser interaction without turning completion into defect feedback', () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'typed-browser-interaction'
    )
    session.lastUserInstruction = '保留的原始开发要求'
    session.pendingUserRequest = {
      requestId: 'login-1',
      type: 'browser_interaction',
      reason: 'login',
      prompt: '请在浏览器中登录',
      url: 'https://example.test/login'
    }
    try {
      const result = testable(developer).applyUserResponse(session, {
        requestId: 'login-1',
        type: 'browser_interaction',
        action: 'completed'
      })
      assert.equal(result.updatesInstruction, false)
      assert.match(result.prompt, /reason=login/)
      assert.match(result.prompt, /只检查 browser\(action="status"\)/)
      assert.match(result.prompt, /不要重新开始探索/)
      assert.equal(session.lastUserInstruction, '保留的原始开发要求')
      assert.equal(session.pendingUserRequest, undefined)
    } finally {
      deleteSession(session.id)
    }
  })

  it('keeps a mechanically ready artifact waiting for user after Pi settles', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-natural-ready-'))
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'natural-ready')
    session.workspaceDirectory = directory
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    session.lastExecution = {
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash: pluginArtifactHash(session.package),
      targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
      scope: 'all',
      targets: structuredClone(session.runTargets),
      cases: session.runTargets.map((target) => ({
        target,
        pluginResult: { code: 'ABC-123', title: 'Semantically unchecked' },
        effectiveResult: { code: 'ABC-123', title: 'Semantically unchecked' },
        manifestCoverage: {
          returnedFieldIds: ['title'],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        runtimeAccepted: true
      })),
      executionPassed: true,
      reportPath: path.join(directory, '.javdex/reports/pass.json')
    }
    const active = activeRun(session)
    let resolvedStatus = ''
    active.waiter = { resolve: (result) => { resolvedStatus = (result as { status: string }).status } }
    testable(developer).active.set(session.id, active)
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    try {
      const projection = testable(developer).runtimeProject(active, {
        type: 'agent.settled',
        acceptedCommandIds: ['natural-ready-operation']
      })
      assert.equal(session.status, 'waiting_user')
      assert.equal(session.phase, 'ready')
      assert.equal(session.acceptance?.ready, true)
      assert.equal(resolvedStatus, 'waiting_user')
      assert.equal(projection.status, 'waiting_user')
      assert.match(active.summary, /可以安装.*输入具体反馈/)
    } finally {
      restoreGetRun()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requires real feedback before continuing a mechanically ready artifact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ready-resume-'))
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'ready-resume'
    )
    session.workspaceDirectory = directory
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    markMechanicallyReady(session, directory)
    const originalExecution = structuredClone(session.lastExecution)
    const active = activeRun(session)
    testable(developer).active.set(session.id, active)
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    const restoreUpdate = replaceMethod(
      agentRunStore,
      'updateProductState',
      (() => undefined) as typeof agentRunStore.updateProductState
    )
    let dispatchCalls = 0
    const restoreDispatch = replaceMethod(agentExecution, 'dispatch', (async () => {
      dispatchCalls += 1
      testable(developer).runtimeProject(active, {
        type: 'agent.settled',
        acceptedCommandIds: ['ready-resume-operation']
      })
      return { operationId: 'ready-resume-operation', accepted: true, duplicate: false }
    }) as typeof agentExecution.dispatch)
    try {
      await assert.rejects(
        developer.message({
          sessionId: session.id,
          text: '请继续当前插件开发/调试任务。',
          continuationKind: 'resume'
        }),
        /请先输入具体反馈/
      )
      assert.equal(dispatchCalls, 0)

      const feedbackResult = await developer.message({
        sessionId: session.id,
        text: '标题仍然不正确',
        continuationKind: 'user_feedback'
      })

      assert.equal(session.lastUserInstruction, '标题仍然不正确')
      assert.deepEqual(session.lastExecution, originalExecution)
      assert.equal(feedbackResult.acceptance?.ready, true)
      assert.equal(dispatchCalls, 1)
    } finally {
      restoreDispatch()
      restoreUpdate()
      restoreGetRun()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps readiness for dev-notes edits but invalidates it for package edits', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ready-file-edits-'))
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'ready-file-edits'
    )
    session.workspaceDirectory = directory
    const workspace = pluginWorkspace.open({ directory, task: input, package: packageValue })
    markMechanicallyReady(session, directory)
    const originalExecution = structuredClone(session.lastExecution)
    const active = activeRun(session)
    const restoreGetRun = replaceMethod(
      agentRunStore,
      'getRun',
      (() => null) as typeof agentRunStore.getRun
    )
    try {
      fs.writeFileSync(workspace.files.devNotes, '# 开发笔记\n\n- 已整理\n', 'utf8')
      testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'notes-edit', toolName: 'edit', ok: true, summary: 'updated dev notes' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'notes-edit' }
      })

      assert.deepEqual(session.lastExecution, originalExecution)
      assert.equal(session.acceptance?.ready, true)
      assert.deepEqual(
        (JSON.parse(fs.readFileSync(workspace.files.latestDryRun, 'utf8')) as {
          currentAcceptance: unknown
        }).currentAcceptance,
        { installReady: true, reasons: [] }
      )

      const manifest = JSON.parse(fs.readFileSync(workspace.files.manifest, 'utf8')) as Record<string, unknown>
      fs.writeFileSync(
        workspace.files.manifest,
        `${JSON.stringify({ ...manifest, name: 'Renamed After Ready' }, null, 2)}\n`,
        'utf8'
      )
      testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'name-edit', toolName: 'edit', ok: true, summary: 'updated plugin name' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'name-edit' }
      })

      assert.deepEqual(session.lastExecution, originalExecution)
      assert.equal(session.acceptance?.ready, true)
      assert.equal(session.package.name, 'Renamed After Ready')

      fs.writeFileSync(
        workspace.files.code,
        'async function scrape(ctx) { return { title: `Edited ${ctx.code}` }; }\n',
        'utf8'
      )
      testable(developer).runtimeProject(active, {
        type: 'tool.completed',
        result: { callId: 'code-edit', toolName: 'edit', ok: true, summary: 'updated index.js' },
        recovery: { codecVersion: 1, payload: '{}', contentHash: 'code-edit' }
      })

      assert.equal(session.lastExecution, undefined)
      assert.equal(session.acceptance, undefined)
      const latest = JSON.parse(fs.readFileSync(workspace.files.latestDryRun, 'utf8')) as {
        artifactHash?: string
        currentAcceptance?: unknown
      }
      assert.equal(latest.artifactHash, originalExecution?.artifactHash)
      assert.deepEqual(latest.currentAcceptance, {
        installReady: false,
        reasons: ['stale_artifact']
      })
    } finally {
      restoreGetRun()
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not run hidden production execution when Pi settles without a current artifact', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-natural-failed-'))
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'natural-failed')
    session.workspaceDirectory = directory
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    testable(developer).active.set(session.id, active)
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    try {
      testable(developer).runtimeProject(active, {
        type: 'agent.settled',
        acceptedCommandIds: ['natural-working-operation']
      })
      assert.equal(session.status, 'waiting_user')
      assert.equal(session.phase, 'working')
      assert.equal(session.lastExecution, undefined)
      assert.equal(events.some((event) => event.type === 'execution_updated'), false)
      assert.match(active.summary, /显式调用完整 plugin_dry_run/)
    } finally {
      restoreGetRun()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('projects a model-turn limit into waiting_user/working without running a hidden check', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-turn-limit-working-'))
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'turn-limit-working')
    session.workspaceDirectory = directory
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    testable(developer).active.set(session.id, active)
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    try {
      const projection = testable(developer).runtimeProject(active, {
        type: 'limit.reached',
        resource: 'model-turns',
        current: 4,
        limit: 4
      })
      assert.equal(session.status, 'waiting_user')
      assert.equal(session.phase, 'working')
      assert.equal(session.lastExecution, undefined)
      assert.equal(events.some((event) => event.type === 'execution_updated'), false)
      assert.match(active.summary, /模型轮次上限/)
      assert.equal(projection.status, 'waiting_user')
    } finally {
      restoreGetRun()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('allows installation only for the exact full production execution artifact', () => {
    const developer = new PluginDeveloper()
    const session = createSession({ ...input, package: structuredClone(packageValue) }, 'ready-install-gate')
    session.lastExecution = {
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash: pluginArtifactHash(session.package),
      targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
      scope: 'all',
      targets: structuredClone(session.runTargets),
      cases: session.runTargets.map((target) => ({
        target,
        pluginResult: { code: 'ABC-123', title: 'unchecked' },
        effectiveResult: { code: 'ABC-123', title: 'unchecked' },
        manifestCoverage: {
          returnedFieldIds: ['title'],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        runtimeAccepted: true
      })),
      reportPath: '/tmp/report.json',
      executionPassed: true
    }
    testable(developer).active.set(session.id, activeRun(session))
    try {
      assert.doesNotThrow(() => developer.assertReadyArtifact(session.id, session.package))
      assert.doesNotThrow(() => developer.assertReadyArtifact(session.id, {
        ...session.package,
        name: 'Renamed For Install'
      }))
      assert.throws(() => developer.assertReadyArtifact(session.id, {
        ...session.package,
        code: `${session.package.code}\n// changed`
      }), /不能安装/)
      session.lastExecution.targetFingerprint = pluginRunTargetFingerprint([{ kind: 'video', code: 'OTHER' }])
      assert.throws(() => developer.assertReadyArtifact(session.id, session.package), /不能安装/)
      session.workspaceDraftError = 'plugin.json 暂时无效'
      assert.throws(
        () => developer.assertReadyArtifact(session.id, session.package),
        /工作区当前无效/
      )
      session.workspaceDraftError = undefined
      assert.throws(() => developer.assertReadyArtifact(session.id, {
        ...session.package,
        code: `${session.package.code}\n// changed after stop`
      }), /不能安装/)
    } finally {
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
    }
  })

  it('marks the session completed only after the accepted artifact is installed', async () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'installed-lifecycle'
    )
    session.status = 'waiting_user'
    session.phase = 'ready'
    session.lastExecution = {
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash: pluginArtifactHash(session.package),
      targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
      scope: 'all',
      targets: structuredClone(session.runTargets),
      cases: session.runTargets.map((target) => ({
        target,
        pluginResult: { code: 'ABC-123', title: 'unchecked' },
        effectiveResult: { code: 'ABC-123', title: 'unchecked' },
        manifestCoverage: {
          returnedFieldIds: ['title'],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        runtimeAccepted: true
      })),
      reportPath: '/tmp/report.json',
      executionPassed: true
    }
    const gate = pluginRunAcceptance.evaluate({
      package: session.package,
      targets: session.runTargets,
      execution: session.lastExecution
    })
    session.acceptance = gate.outcome
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    testable(developer).active.set(session.id, active)
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    const restoreDiscard = replaceMethod(toolHost, 'discardApprovals', (() => undefined) as typeof toolHost.discardApprovals)
    const restoreDispose = replaceMethod(toolHost, 'disposeRun', (() => undefined) as typeof toolHost.disposeRun)
    const restoreRelease = replaceMethod(agentExecution, 'releaseRun', (async () => undefined) as typeof agentExecution.releaseRun)
    try {
      developer.markInstalled(session.id, session.package)

      assert.equal(session.status, 'completed')
      assert.equal(session.phase, 'ready')
      assert.ok(session.endedAt)
      assert.equal(events.some((event) => event.type === 'done' && event.success), true)
    } finally {
      restoreRelease()
      restoreDispose()
      restoreDiscard()
      restoreGetRun()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
    }
  })

  it('adopts the installed display name when install renames to avoid a conflict', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-install-rename-'))
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'installed-rename'
    )
    session.workspaceDirectory = directory
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    session.status = 'waiting_user'
    session.phase = 'ready'
    session.lastExecution = {
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash: pluginArtifactHash(session.package),
      targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
      scope: 'all',
      targets: structuredClone(session.runTargets),
      cases: session.runTargets.map((target) => ({
        target,
        pluginResult: { code: 'ABC-123', title: 'unchecked' },
        effectiveResult: { code: 'ABC-123', title: 'unchecked' },
        manifestCoverage: {
          returnedFieldIds: ['title'],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        runtimeAccepted: true
      })),
      reportPath: '/tmp/report.json',
      executionPassed: true
    }
    session.acceptance = pluginRunAcceptance.evaluate({
      package: session.package,
      targets: session.runTargets,
      execution: session.lastExecution
    }).outcome
    const events: PluginDevAgentEvent[] = []
    const active = { ...activeRun(session), emit: (event: PluginDevAgentEvent) => events.push(event) }
    testable(developer).active.set(session.id, active)
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => null) as typeof agentRunStore.getRun)
    const restoreDiscard = replaceMethod(toolHost, 'discardApprovals', (() => undefined) as typeof toolHost.discardApprovals)
    const restoreDispose = replaceMethod(toolHost, 'disposeRun', (() => undefined) as typeof toolHost.disposeRun)
    const restoreRelease = replaceMethod(agentExecution, 'releaseRun', (async () => undefined) as typeof agentExecution.releaseRun)
    const renamed = { ...session.package, name: 'missav-003' }
    try {
      developer.markInstalled(session.id, renamed)

      const done = events.find((event) => event.type === 'done')
      assert.ok(done && done.type === 'done')
      assert.equal(done.package.name, 'missav-003')
      assert.equal(session.package.name, 'missav-003')
      assert.equal(session.siteName, 'missav-003')
      assert.equal(active.input.siteName, 'missav-003')
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8')).name,
        'missav-003'
      )
    } finally {
      restoreRelease()
      restoreDispose()
      restoreDiscard()
      restoreGetRun()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists the renamed installed package onto settled product state', () => {
    const developer = new PluginDeveloper()
    const lastExecution = {
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash: pluginArtifactHash(packageValue),
      targetFingerprint: pluginRunTargetFingerprint([{ kind: 'video' as const, code: 'ABC-123' }]),
      scope: 'all' as const,
      targets: [{ kind: 'video' as const, code: 'ABC-123' }],
      cases: [{
        target: { kind: 'video' as const, code: 'ABC-123' },
        pluginResult: { code: 'ABC-123', title: 'unchecked' },
        effectiveResult: { code: 'ABC-123', title: 'unchecked' },
        manifestCoverage: {
          returnedFieldIds: ['title'],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        runtimeAccepted: true
      }],
      reportPath: '/tmp/report.json',
      executionPassed: true
    }
    const productState = {
      schemaVersion: 1 as const,
      input: { ...input },
      status: 'waiting_user' as const,
      phase: 'ready' as const,
      step: 4,
      totalTokens: 0,
      modelTurnCount: 0,
      discoveryToolCalls: 0,
      runTargets: [{ kind: 'video' as const, code: 'ABC-123' }],
      package: structuredClone(packageValue),
      lastExecution,
      summary: 'ready',
      workLog: []
    }
    const record = {
      id: 'installed-rename-settled',
      useCase: 'plugin-developer',
      status: 'waiting_user',
      activeOperationId: 'op-install',
      configRevision: 'test',
      configSnapshot: frozenSnapshot(),
      recoveryGeneration: 0,
      productState,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z'
    } satisfies AgentRunRecord<typeof productState>
    const directory = path.join(
      process.env.JAVDEX_TEST_USER_DATA!,
      'agent-sessions',
      record.id
    )
    pluginWorkspace.open({ directory, task: input, package: packageValue })
    let persisted: typeof productState | undefined
    const restoreGetRun = replaceMethod(agentRunStore, 'getRun', (() => record) as typeof agentRunStore.getRun)
    const restoreUpdate = replaceMethod(
      agentRunStore,
      'updateProductState',
      ((_, __, next) => {
        persisted = next as typeof productState
      }) as typeof agentRunStore.updateProductState
    )
    const restoreAppend = replaceMethod(
      agentRunStore,
      'appendProductEvent',
      (() => 0) as typeof agentRunStore.appendProductEvent
    )
    const restoreArtifact = replaceMethod(
      agentRunStore,
      'recordArtifact',
      ((() => undefined) as unknown) as typeof agentRunStore.recordArtifact
    )
    try {
      developer.markInstalled(record.id, { ...packageValue, name: 'missav-003' })
      assert.equal(persisted?.package.name, 'missav-003')
      assert.equal(persisted?.input.siteName, 'missav-003')
      assert.equal(persisted?.status, 'completed')
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8')).name,
        'missav-003'
      )
    } finally {
      restoreArtifact()
      restoreAppend()
      restoreUpdate()
      restoreGetRun()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('releases only PluginDeveloper-owned runs during application disposal', async () => {
    const developer = new PluginDeveloper()
    const session = createSession(
      { ...input, package: structuredClone(packageValue) },
      'plugin-dispose-owned-run'
    )
    testable(developer).active.set(session.id, activeRun(session))
    const released: string[] = []
    let globalDisposeCalls = 0
    const restoreDiscard = replaceMethod(
      toolHost,
      'discardApprovals',
      (() => undefined) as typeof toolHost.discardApprovals
    )
    const restoreToolDispose = replaceMethod(
      toolHost,
      'disposeRun',
      (() => undefined) as typeof toolHost.disposeRun
    )
    const restoreRelease = replaceMethod(
      agentExecution,
      'releaseRun',
      (async (runId) => { released.push(runId) }) as typeof agentExecution.releaseRun
    )
    const restoreGlobalDispose = replaceMethod(
      agentExecution,
      'dispose',
      (async () => { globalDisposeCalls += 1 }) as typeof agentExecution.dispose
    )
    try {
      await developer.dispose()

      assert.deepEqual(released, [session.id])
      assert.equal(globalDisposeCalls, 0)
      assert.equal(testable(developer).active.size, 0)
    } finally {
      restoreGlobalDispose()
      restoreRelease()
      restoreToolDispose()
      restoreDiscard()
      testable(developer).active.delete(session.id)
      deleteSession(session.id)
    }
  })
})

it('uses the indexed journal cursor for active and persisted plugin snapshots', (t) => {
  const developer = new PluginDeveloper()
  const session = createSession({ ...input, package: structuredClone(packageValue) }, 'snapshot-cursor')
  testable(developer).active.set(session.id, activeRun(session))
  const cursor = t.mock.method(agentRunStore, 'getProductJournalCursor', () => 12345)
  t.mock.method(toolHost, 'pendingApprovals', () => [])
  t.mock.method(agentRunStore, 'readProductJournal', () => { throw new Error('snapshot must not load the journal') })
  try {
    const snapshot = developer.getSnapshot(session.id)
    assert.equal(snapshot?.cursor, 12345)
    assert.equal(cursor.mock.callCount(), 1)
    assert.equal(cursor.mock.calls[0].arguments[0], session.id)
    assert.deepEqual(snapshot?.workLog, [])
    testable(developer).active.delete(session.id)
    const record: AgentRunRecord = {
      id: session.id, useCase: 'plugin-developer', status: 'settled', configRevision: 'test',
      configSnapshot: frozenSnapshot(), recoveryGeneration: 0, createdAt: '', updatedAt: '',
      productState: {
        schemaVersion: 1, input, status: 'completed', package: packageValue, runTargets: [],
        summary: 'finished', phase: 'ready', step: 1, totalTokens: 17, workLog: []
      }
    }
    t.mock.method(agentRunStore, 'getRun', (() => record) as typeof agentRunStore.getRun)
    const persisted = developer.getSnapshot(session.id)
    assert.equal(persisted?.cursor, 12345)
    assert.equal(persisted?.result.status, 'completed')
    assert.equal(cursor.mock.callCount(), 2)
  } finally {
    t.mock.restoreAll()
    deleteSession(session.id)
  }
})


it('preserves incremental logs across stale-runtime cancellation, cold snapshot, restore and export', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-log-integration-'))
  initDatabaseAtPath(path.join(directory, 'test.sqlite'))
  const developer = new PluginDeveloper()
  const session = createSession({ ...input, package: structuredClone(packageValue) }, 'incremental-domain-log')
  const active = activeRun(session)
  testable(developer).active.set(session.id, active)
  const execution = new AgentExecution(agentRunStore, async () => ({
    runtimeId: 'pi',
    open: async () => ({
      source: 'restored',
      session: {
        ref: { runtimeId: 'pi', sessionId: 'test', sessionFile: path.join(directory, 'runtime.jsonl'), codecVersion: 1 },
        dispatch: async () => ({ accepted: true }), requestManualCompaction: async () => ({ accepted: true }),
        abort: async () => {}, dispose: async () => {}
      }
    }),
    rebuild: async () => { throw new Error('unexpected rebuild') }
  }))
  try {
    const db = getDb()
    db.prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'plugin-developer','running','test',?,'pi',?,'now','now')`)
      .run(session.id, JSON.stringify(frozenSnapshot()), JSON.stringify({ schemaVersion: 1, workLog: [] }))
    const clone = globalThis.structuredClone
    const guard = t.mock.method(globalThis, 'structuredClone', ((value: unknown) => {
      assert.notEqual(value, session.workLog, 'event persistence must not clone the full work log')
      return clone(value)
    }) as typeof globalThis.structuredClone)
    for (let index = 0; index < 1000; index++) {
      testable(developer).emitDomainEvent(active, { type: 'step_start', sessionId: session.id, step: index })
    }
    guard.mock.restore()
    const stored = agentRunStore.getRun(session.id)!.productState
    assert.equal(stored.schemaVersion, 2)
    assert.equal(Array.isArray(stored.workLog), false)
    assert.equal((stored.workLog as { count: number }).count, 1000)
    assert.equal((db.prepare("SELECT COUNT(*) AS total FROM agent_product_journal WHERE event_type = 'plugin.work_log_entry'")
      .get() as { total: number }).total, 1000)
    const frozen = frozenSnapshot()
    await execution.openRun({ useCase: 'plugin-developer', productState: stored,
      resume: agentRunStore.getRun(session.id)!,
      resolved: { ...frozen, model: access('primary'), verifierModel: undefined, tools: [], sessionDirectory: directory }
    })
    // The runtime retains count=1000; this product event advances only durable state.
    testable(developer).emitDomainEvent(active, { type: 'step_start', sessionId: session.id, step: 1000 })
    const expected = structuredClone(session.workLog)
    t.mock.method(agentExecution, 'abort', execution.abort.bind(execution))
    t.mock.method(agentExecution, 'releaseRun', execution.releaseRun.bind(execution))
    await developer.cancel(session.id)
    const cancelled = agentRunStore.getRun(session.id)!
    assert.equal(cancelled.status, 'cancelled')
    assert.equal((cancelled.productState.workLog as { count: number }).count, 1001)
    const snapshot = developer.getSnapshot(session.id)!
    assert.deepEqual(snapshot.workLog, expected)
    assert.equal(snapshot.events.length, 1001)
    const exported = buildPluginDevAgentWorkLogFromSnapshot(snapshot)
    assert.deepEqual(exported.entries, expected)
    assert.equal(exported.timeline.length, 1001)
    const restored = testable(developer).restoreSession(session.id, cancelled.productState)
    assert.deepEqual(restored.workLog, expected)
    testable(developer).emitDomainEvent(activeRun(restored), { type: 'step_start', sessionId: restored.id, step: 1001 })
    assert.equal((agentRunStore.getRun(restored.id)!.productState.workLog as { count: number }).count, 1002)
  } finally {
    t.mock.restoreAll()
    testable(developer).active.delete(session.id)
    deleteSession(session.id)
    await execution.dispose()
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps the migrated work log reference when runtime reopen fails during recovery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-log-recovery-'))
  initDatabaseAtPath(path.join(directory, 'test.sqlite'))
  const developer = new PluginDeveloper()
  const id = 'log-recovery-failure'
  const legacy = [{ at: '2026-09-10T00:00:00Z', kind: 'user_message', sessionId: id, source: 'start', text: 'keep this message' }]
  const frozen = frozenSnapshot()
  try {
    getDb().prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'plugin-developer','waiting_user','test',?,'pi',?,'now','now')`)
      .run(id, JSON.stringify(frozen), JSON.stringify({
        schemaVersion: 1, input, package: packageValue, status: 'waiting_user', phase: 'working',
        step: 1, totalTokens: 0, modelTurnCount: 0, discoveryToolCalls: 0, runTargets: [], summary: 'old', workLog: legacy
      }))
    t.mock.method(testable(developer), 'materializeWorkspace', () => {})
    t.mock.method(testable(developer), 'restoredConfiguration', () => ({
      ...frozen, model: access('primary'), verifierModel: undefined, tools: [], sessionDirectory: directory
    }))
    t.mock.method(agentExecution, 'openRun', async () => { throw new Error('restore open failure') })
    assert.deepEqual(await developer.restoreRecoverableRuns(), [{ runId: id, error: 'restore open failure' }])
    const current = agentRunStore.getRun(id)!
    assert.equal(current.productState.schemaVersion, 2)
    assert.equal(current.productState.recoveryBlocked, true)
    assert.equal(Array.isArray(current.productState.workLog), false)
    assert.deepEqual(developer.getSnapshot(id)?.workLog, legacy)
  } finally {
    t.mock.restoreAll()
    deleteSession(id)
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('retries closed workspaces with intact or corrupted state without rewriting diagnostic data', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-cleanup-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = directory
  initDatabaseAtPath(path.join(directory, 'test.sqlite'))
  const id = 'cleanup-retry'
  const workspace = path.join(directory, 'agent-sessions', id)
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'keep-until-retry.txt'), 'test')
  try {
    getDb().prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'plugin-developer','settled','test',?,'pi','{}','now','now')`).run(id, JSON.stringify(frozenSnapshot()))
    const corruptId = 'corrupt-cleanup'
    getDb().prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'plugin-developer','settled','test','bad config','pi','bad state','now','now')`).run(corruptId)
    const corruptWorkspace = path.join(directory, 'agent-sessions', corruptId)
    fs.mkdirSync(corruptWorkspace)
    fs.writeFileSync(path.join(corruptWorkspace, 'file.txt'), 'test')
    const remove = fs.promises.rm
    const fault = t.mock.method(fs.promises, 'rm', async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (target === workspace) throw new Error('file locked')
      await remove(target, options)
    })
    await assert.rejects(() => new PluginDeveloper().clearHistory(), /file locked/)
    assert.equal(agentRunStore.getRun(id)?.status, 'closed')
    assert.equal((getDb().prepare('SELECT COUNT(*) AS total FROM agent_resource_cleanup WHERE run_id = ?').get(id) as { total: number }).total, 1)
    agentRunStore.updateProductState(id, 'closed', { summary: 'late state update' })
    assert.equal((getDb().prepare('SELECT COUNT(*) AS total FROM agent_resource_cleanup WHERE run_id = ?').get(id) as { total: number }).total, 1)
    assert.deepEqual([...agentRunStore.iterateRecoverableRunIds('plugin-developer')], [corruptId])
    assert.deepEqual(new Set(agentRunStore.iterateCleanupRunIds('plugin-developer')), new Set([id, corruptId]))
    assert.equal(fs.existsSync(workspace), true)
    fault.mock.restore()
    const corruptFault = t.mock.method(fs.promises, 'rm', async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (target === corruptWorkspace) throw new Error('corrupt workspace locked')
      await remove(target, options)
    })
    await assert.rejects(() => new PluginDeveloper().discardUnrecoverableSessions(), /corrupt workspace locked/)
    assert.deepEqual([...agentRunStore.iterateCleanupRunIds('plugin-developer')], [corruptId])
    assert.equal(fs.existsSync(corruptWorkspace), true)
    assert.deepEqual(getDb().prepare('SELECT status, product_state_json, config_snapshot_json FROM agent_runs WHERE id = ?').get(corruptId),
      { status: 'closed', product_state_json: 'bad state', config_snapshot_json: 'bad config' })
    corruptFault.mock.restore()
    assert.equal(await new PluginDeveloper().discardUnrecoverableSessions(), 1)
    assert.equal(fs.existsSync(workspace), false)
    assert.equal(fs.existsSync(corruptWorkspace), false)
    assert.deepEqual(getDb().prepare('SELECT status, product_state_json, config_snapshot_json FROM agent_runs WHERE id = ?').get(corruptId),
      { status: 'closed', product_state_json: 'bad state', config_snapshot_json: 'bad config' })
    assert.equal((getDb().prepare('SELECT COUNT(*) AS total FROM agent_resource_cleanup WHERE run_id = ?').get(id) as { total: number }).total, 0)
    assert.deepEqual([...agentRunStore.iterateCleanupRunIds('plugin-developer')], [])
  } finally {
    t.mock.restoreAll()
    closeDatabase()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

for (const scenario of [
  { initial: 'clear', fail: false, dispose: true },
  { initial: 'discard', fail: true, dispose: true },
  { initial: 'clear', fail: true, dispose: false }
] as const) {
  it(`serializes cleanup admission and drains safely: ${JSON.stringify(scenario)}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-cleanup-admission-'))
    const previous = process.env.JAVDEX_TEST_USER_DATA
    process.env.JAVDEX_TEST_USER_DATA = directory
    initDatabaseAtPath(path.join(directory, 'test.sqlite'))
    const developer = new PluginDeveloper()
    const id = 'cleanup-admission'
    const workspace = path.join(directory, 'agent-sessions', id)
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'test')
    getDb().prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'plugin-developer','settled','test','{}','pi','{}','now','now')`).run(id)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const remove = fs.promises.rm
    const removal = t.mock.method(fs.promises, 'rm', async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (target === workspace) {
        entered()
        await gate
        if (scenario.fail) throw new Error('cleanup failure')
      }
      await remove(target, options)
    })
    const pending = scenario.initial === 'clear' ? developer.clearHistory() : developer.discardUnrecoverableSessions()
    const outcome = pending.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
    let shutdown: Promise<void> | undefined
    try {
      await started
      await assert.rejects(() => developer.clearHistory(), /正在清理/)
      await assert.rejects(() => developer.discardUnrecoverableSessions(), /正在清理/)
      assert.equal(removal.mock.callCount(), 1)
      let disposed = false
      if (scenario.dispose) {
        shutdown = developer.dispose().then(() => { disposed = true })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(disposed, false)
        await assert.rejects(() => developer.clearHistory(), /正在退出/)
        await assert.rejects(() => developer.discardUnrecoverableSessions(), /正在退出/)
      }
      assert.equal(fs.existsSync(workspace), true)
      release()
      const result = await outcome
      if (scenario.fail) assert.match(String(result.error), /cleanup failure/)
      else assert.equal(result.value, 1)
      if (shutdown) { await shutdown; assert.equal(disposed, true) }
      const queued = () => (getDb().prepare('SELECT COUNT(*) AS total FROM agent_resource_cleanup').get() as { total: number }).total
      assert.equal(queued(), scenario.fail ? 1 : 0)
      removal.mock.restore()
      if (scenario.fail) {
        const retry = scenario.dispose ? new PluginDeveloper() : developer
        assert.equal(await retry.clearHistory(), 1)
        assert.equal(queued(), 0)
      }
      assert.equal(fs.existsSync(workspace), false)
    } finally {
      release()
      await outcome
      await shutdown
      t.mock.restoreAll()
      closeDatabase()
      if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
      else process.env.JAVDEX_TEST_USER_DATA = previous
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
