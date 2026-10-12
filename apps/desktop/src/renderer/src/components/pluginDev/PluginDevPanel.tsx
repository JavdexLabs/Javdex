import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Code2, Settings } from 'lucide-react'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import type { ActressScrapeField, ScraperPluginPackage, VideoScrapeField } from '@shared/scrapeTypes'
import type {
  PluginDevAgentEvent,
  PluginDevAgentMessageInput,
  PluginDevAgentSnapshot,
  PluginDevAgentWorkLogEntry,
  PluginDevDryRunResult,
  PluginExecutionArtifact,
  PluginRunAcceptanceOutcome,
  PluginDevPendingApproval,
  PluginDevPendingUserRequest,
  PluginDevSessionStatus,
  PluginDevUserResponse
} from '@shared/pluginDevTypes'
import { api } from '../../api'
import { settingsPath } from '../../settings/settingsRoutes'
import IconButton from '../IconButton'
import ConfirmModal from '../ConfirmModal'
import { useToast } from '../Toast'
import { UI_ICON_MD } from '../iconDefaults'
import {
  WorkbenchMain,
  WorkbenchShell,
  WorkbenchStatusPill,
  WorkbenchToolbar
} from '../workbench'
import PluginDevAgentRail from './PluginDevAgentRail'
import PluginSourceBadge from '../PluginSourceBadge'
import PluginDevCodeModal from './PluginDevCodeModal'
import PluginDevConnectionModal from './PluginDevConnectionModal'
import PluginDevConfigRail from './PluginDevConfigRail'
import { usePluginDevLeaveGuard } from './PluginDevLeaveGuard'
import { fingerprintPluginPackage, fingerprintPluginRuntime } from './pluginDevPackageSnapshot'
import { suggestForkedPluginName } from './pluginDevName'
import {
  canClearPluginDevAgentHistory,
  canInstallPluginDevDraft,
  checkPluginDevMessageDispatch,
  createPluginDevSnapshotGate,
  listPluginDevSelectablePlugins,
  packageFromPluginDevAgentEvent,
  pluginDevAgentEndNotice,
  pluginDevLoadedPluginIdentity,
  requiresPluginDevContinuationFeedback,
  resolvePluginDevAgentEvent,
  shouldApplyInitialPluginDevSnapshot,
  shouldIgnorePluginDevSelection,
  shouldReleaseAgentBusyForEvent,
  type PluginDevLocalAgentOperation
} from './pluginDevAgentUiState'
import { agentStatusLabel, type PluginDevAgentTab, type PluginDevConversationItem, type PluginKind } from './types'
import {
  allFieldsForKind,
  fieldLabelForKind,
  getPluginDevKindProfile,
  parseTestTargetList,
  runTargetLabel,
  testTargetsFromDryRun
} from '@shared/pluginDevKindProfile'
import styles from './PluginDevPanel.module.css'
import { draftFromPluginPackage, usePluginDevDraft } from './usePluginDevDraft'
import { emptyPluginDevRun, nextConversationId, pluginDevRunReducer } from './pluginDevRunProjection'

function canResumeAgentSession(
  sessionId: string | null,
  status: PluginDevSessionStatus | null
): boolean {
  if (!sessionId) return false
  return (
    status === 'waiting_user' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'completed'
  )
}

function shouldOpenResultAfterAgentDone(
  status: PluginDevSessionStatus | null,
  execution: PluginExecutionArtifact | undefined | null,
  acceptance?: PluginRunAcceptanceOutcome | null
): boolean {
  return (
    (status === 'completed' || status === 'waiting_user') &&
    acceptance?.ready === true &&
    Boolean(execution)
  )
}

function isActiveAgentSessionStatus(status: PluginDevSessionStatus | null): boolean {
  return status === 'running' || status === 'waiting_user'
}

function derivePluginNameFromUrl(url: string, kind: PluginKind): string {
  const fallback = getPluginDevKindProfile(kind).defaultPluginNameSuffix
  const text = url.trim()
  if (!text) return fallback
  try {
    const host = new URL(text).hostname.replace(/^www\./i, '')
    return host.split('.')[0]?.trim() || fallback
  } catch {
    const match = /https?:\/\/(?:www\.)?([^/?#]+)/i.exec(text)
    return match?.[1]?.split('.')[0]?.trim() || fallback
  }
}

function conversationFromWorkLog(
  entries: PluginDevAgentWorkLogEntry[]
): PluginDevConversationItem[] {
  return entries.flatMap((entry): PluginDevConversationItem[] => {
    if (entry.kind === 'user_message') {
      return [{ id: nextConversationId('user:restore'), type: 'user', text: entry.text }]
    }
    const event = entry.event
    if (event.type === 'assistant_text') {
      return [{
        id: event.turn === undefined
          ? nextConversationId('agent:restore')
          : `assistant:${event.sessionId}:${event.turn}`,
        type: 'agent',
        turn: event.turn,
        text: event.text,
        streaming: false
      }]
    }
    if (event.type === 'assistant_reasoning') {
      return [{
        id: `reasoning:${event.sessionId}:${event.turn}`,
        type: 'reasoning',
        step: event.step,
        turn: event.turn,
        text: event.text,
        charCount: event.charCount,
        truncated: event.truncated
      }]
    }
    if (event.type === 'workspace_status') {
      return [{
        id: nextConversationId(`workspace:restore:${event.step}`),
        type: 'tool',
        step: event.step,
        tool: 'workspace_validate',
        summary: event.message,
        ok: event.valid
      }]
    }
    if (event.type === 'tool_result') {
      return [{
        id: nextConversationId(`tool:restore:${event.step}:${event.tool}`),
        type: 'tool',
        step: event.step,
        tool: event.tool,
        summary: event.summary,
        detail: event.detail,
        ok: event.ok
      }]
    }
    if (event.type === 'error') {
      return [{ id: nextConversationId('agent:error:restore'), type: 'agent', text: event.message }]
    }
    return []
  }).slice(-120)
}

export default function PluginDevPanel({
  onInstalled,
  loadPackage,
  onLoadConsumed,
  presentation = 'standalone'
}: {
  onInstalled: (kind: PluginKind) => Promise<void>
  loadPackage: ScraperPluginPackage | null
  onLoadConsumed: () => void
  presentation?: 'standalone' | 'settings'
}): JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const leaveGuard = usePluginDevLeaveGuard()
  const [run, dispatchRun] = useReducer(pluginDevRunReducer, undefined, emptyPluginDevRun)
  const runRef = useRef(run); runRef.current = run
  const transitionRun = useCallback((action: Parameters<typeof pluginDevRunReducer>[1]) => {
    const next = pluginDevRunReducer(runRef.current, action)
    runRef.current = next
    dispatchRun({ type: 'patch', patch: next })
  }, [])
  const { agentSessionId, agentStatus, agentPhase, agentStep, contextStats, activeTool, conversationItems, waitingUserReason, pendingApproval, pendingUserRequest, frozenModel, execution, acceptance, executionPackageFingerprint, hasAgentHistory } = run
  const [modelManagement, setModelManagement] = useState<ModelManagementSnapshot | null>(null)
  const [modelManagementError, setModelManagementError] = useState<string | null>(null)
  const [showConnectionModal, setShowConnectionModal] = useState(false)
  const [showCodeModal, setShowCodeModal] = useState(false)
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false)
  const [agentTab, setAgentTab] = useState<PluginDevAgentTab>('conversation')
  const { draft, edit: editDraft, applyGenerated: applyGeneratedPackage, load: loadDraft, reset: resetDraft } = usePluginDevDraft()
  const { kind, siteName, siteUrl, testTarget, description, version, author, supportedFieldIds, code } = draft
  const [busy, setBusy] = useState<'save-key' | 'agent' | 'install' | 'clear-history' | null>(null)
  const [exportWorkLogBusy, setExportWorkLogBusy] = useState(false)
  const [dryRun, setDryRun] = useState<PluginDevDryRunResult | null>(null)
  const [dryRunPackageFingerprint, setDryRunPackageFingerprint] = useState<string | null>(null)
  const [loadedInstalledName, setLoadedInstalledName] = useState<string | null>(null)
  /** Non-null while editing a draft forked from a built-in plugin (not yet installed as custom). */
  const [forkedFromBuiltIn, setForkedFromBuiltIn] = useState<string | null>(null)
  const [installedBaseline, setInstalledBaseline] = useState<string | null>(null)
  const [selectedPluginName, setSelectedPluginName] = useState('')
  const [selectablePlugins, setSelectablePlugins] = useState<
    Array<{ name: string; source: 'user' | 'builtin' }>
  >([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const agentSessionIdRef = useRef<string | null>(null)
  const agentStatusRef = useRef<PluginDevSessionStatus | null>(null)
  const pendingApprovalRef = useRef<PluginDevPendingApproval | null>(null)
  const pendingUserRequestRef = useRef<PluginDevPendingUserRequest | null>(null)
  const localAgentOperationRef = useRef<PluginDevLocalAgentOperation | null>(null)
  const localAgentOperationSeqRef = useRef(0)
  const initialSnapshotPendingRef = useRef(true)
  const snapshotGateRef = useRef(createPluginDevSnapshotGate())
  const latestSnapshotCursorRef = useRef(-1)
  const packageFingerprintRef = useRef<string | null>(null)
  const onLoadConsumedRef = useRef(onLoadConsumed)

  const updateAgentSessionId = useCallback((sessionId: string | null): void => {
    agentSessionIdRef.current = sessionId
    transitionRun({ type: 'patch', patch: { agentSessionId: sessionId, ...(sessionId ? { hasAgentHistory: true } : {}) } })
  }, [transitionRun])

  const updateAgentStatus = useCallback((status: PluginDevSessionStatus | null): void => {
    agentStatusRef.current = status
    transitionRun({ type: 'patch', patch: { agentStatus: status } })
  }, [transitionRun])

  const updatePendingApproval = useCallback((approval: PluginDevPendingApproval | null): void => {
    pendingApprovalRef.current = approval
    transitionRun({ type: 'patch', patch: { pendingApproval: approval } })
  }, [transitionRun])

  const updatePendingUserRequest = useCallback((request: PluginDevPendingUserRequest | null): void => {
    pendingUserRequestRef.current = request
    transitionRun({ type: 'patch', patch: { pendingUserRequest: request } })
  }, [transitionRun])

  const allFields = allFieldsForKind(kind)
  const kindProfile = useMemo(() => getPluginDevKindProfile(kind), [kind])
  const testTargets = useMemo(() => parseTestTargetList(testTarget), [testTarget])
  const resolvedTestTargets = useMemo(() => {
    if (testTargets.length > 0) return testTargets
    return testTargetsFromDryRun(kind, dryRun)
  }, [kind, testTargets, dryRun])
  const canResumeAgent = canResumeAgentSession(agentSessionId, agentStatus)
  const hasPackage = (siteName.trim().length > 0 || siteUrl.trim().length > 0) && code.trim().length > 0
  const pluginModelAssignment = modelManagement?.assignments.find(
    (assignment) => assignment.workloadId === 'plugin-developer'
  )
  const activeLlmModelLabel = frozenModel?.modelName ?? pluginModelAssignment?.resolution.modelName ?? ''
  const llmReady = Boolean(frozenModel) || pluginModelAssignment?.resolution.ready === true
  const activeLlmProviderLabel = frozenModel
    ? modelManagement?.connections.find(
      (connection) => connection.providerId === frozenModel.providerId
    )?.name ?? frozenModel.providerId
    : pluginModelAssignment?.resolution.providerName ?? '未配置'
  const llmReason = llmReady ? null : modelManagementError ?? (
    modelManagement?.validationErrors[0] ??
    pluginModelAssignment?.resolution.reason ??
    '插件开发用途尚未配置可用模型。'
  )
  const canUseAgent =
    llmReady &&
    (loadedInstalledName ? siteName.trim().length > 0 : siteUrl.trim().length > 0)
  const hasTestTarget = resolvedTestTargets.length > 0
  const feedbackPending = feedbackText.trim().length > 0
  const canStartAgent = canUseAgent && (!hasPackage || hasTestTarget)
  const canSendAgentFeedback =
    canUseAgent && hasPackage && (hasTestTarget || canResumeAgent) && !pendingApproval &&
    (!pendingUserRequest || pendingUserRequest.type === 'freeform')
  const activeAgent = busy === 'agent' || isActiveAgentSessionStatus(agentStatus)
  const agentDisabledReason = !canUseAgent
    ? llmReason || (loadedInstalledName ? '请先选择或填写插件名。' : '请先填写网站主页。')
    : hasPackage && !hasTestTarget && !canResumeAgent
      ? kindProfile.aiDebugNeedsTargetMessage
      : null

  useEffect(() => {
    let cancelled = false
    void api.settings.getModelManagement()
      .then((snapshot) => {
        if (!cancelled) {
          setModelManagement(snapshot)
          setModelManagementError(null)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setModelManagementError((error as Error).message)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    agentSessionIdRef.current = agentSessionId
  }, [agentSessionId])

  useEffect(() => {
    return () => {
      const sessionId = agentSessionIdRef.current
      if (sessionId) void api.pluginDev.releaseBrowser(sessionId)
      void api.pluginDev.discardUnrecoverableSessions()
    }
  }, [])

  useEffect(() => {
    agentStatusRef.current = agentStatus
  }, [agentStatus])

  useEffect(() => {
    onLoadConsumedRef.current = onLoadConsumed
  }, [onLoadConsumed])

  const beginLocalAgentOperation = useCallback((
    kind: PluginDevLocalAgentOperation['kind'],
    sessionId: string | null
  ): PluginDevLocalAgentOperation => {
    snapshotGateRef.current.observeMutation()
    localAgentOperationSeqRef.current += 1
    const operation = { id: localAgentOperationSeqRef.current, kind, sessionId }
    localAgentOperationRef.current = operation
    return operation
  }, [])

  const finishLocalAgentOperation = useCallback((operation: PluginDevLocalAgentOperation): void => {
    if (localAgentOperationRef.current?.id !== operation.id) return
    localAgentOperationRef.current = null
    transitionRun({ type: 'patch', patch: { activeTool: null } })
    setBusy(agentStatusRef.current === 'running' ? 'agent' : null)
  }, [transitionRun])

  const applyAgentSnapshot = useCallback((snapshot: PluginDevAgentSnapshot): void => {
    const { input, result } = snapshot
    latestSnapshotCursorRef.current = Math.max(latestSnapshotCursorRef.current, snapshot.cursor)
    agentSessionIdRef.current = result.sessionId
    agentStatusRef.current = result.status
    pendingApprovalRef.current = snapshot.pendingApprovals?.[0] ?? null
    pendingUserRequestRef.current = snapshot.pendingUserRequest ?? null
    transitionRun({ type: 'snapshot', snapshot, conversation: conversationFromWorkLog(snapshot.workLog) })
    setBusy((current) => localAgentOperationRef.current || result.status === 'running' ? 'agent' : current === 'agent' ? null : current)
    editDraft({ ...draftFromPluginPackage(result.package), siteUrl: result.package.homepage ?? input.siteUrl ?? '', testTarget: result.runTargets.map(runTargetLabel).join('\n') })
  }, [editDraft, transitionRun])

  const readStableAgentSnapshot = useCallback(async (
    expectedSessionId?: string
  ): Promise<PluginDevAgentSnapshot | null> => {
    // A live event invalidates the in-flight result. Retry against the newer
    // journal projection instead of letting an old snapshot roll UI state back.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const version = snapshotGateRef.current.begin()
      const snapshot = await api.pluginDev.snapshot()
      if (!snapshotGateRef.current.canApply(version)) continue
      if (!snapshot) return null
      if (expectedSessionId && snapshot.result.sessionId !== expectedSessionId) return null
      if (snapshot.cursor < latestSnapshotCursorRef.current) continue
      return snapshot
    }
    return null
  }, [])

  const refreshUserPlugins = useCallback(async (pluginKind: PluginKind): Promise<void> => {
    setPluginsLoading(true)
    try {
      const details =
        pluginKind === 'video'
          ? await api.scrape.listPluginDetails()
          : await api.actressScrape.listPluginDetails()
      setSelectablePlugins(listPluginDevSelectablePlugins(details))
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      setSelectablePlugins([])
    } finally {
      setPluginsLoading(false)
    }
  }, [toast])

  useEffect(() => {
    const off = api.pluginDev.onAgentEvent((event: PluginDevAgentEvent) => {
      const resolution = resolvePluginDevAgentEvent({
        eventSessionId: event.sessionId,
        activeSessionId: agentSessionIdRef.current,
        operation: localAgentOperationRef.current,
        allowSnapshotBootstrap: initialSnapshotPendingRef.current
      })
      if (!resolution.accepted) return

      snapshotGateRef.current.observeMutation()
      localAgentOperationRef.current = resolution.operation
      if (resolution.sessionId !== agentSessionIdRef.current) {
        updateAgentSessionId(resolution.sessionId)
      }

      if (shouldReleaseAgentBusyForEvent(event, localAgentOperationRef.current)) {
        setBusy((current) => current === 'agent' ? null : current)
      }

      const eventPackage = packageFromPluginDevAgentEvent(event)
      if (eventPackage) applyGeneratedPackage(eventPackage)

      transitionRun({ type: 'event', event, runtimeFingerprint: packageFingerprintRef.current })
      const projected = runRef.current
      agentStatusRef.current = projected.agentStatus
      pendingApprovalRef.current = projected.pendingApproval
      pendingUserRequestRef.current = projected.pendingUserRequest
      if (event.type === 'step_start') setBusy((current) => current ?? 'agent')
      if (event.type === 'run_targets_updated') editDraft({ testTarget: event.runTargets.map(runTargetLabel).join('\n') })
      if (event.type === 'execution_updated' || (event.type === 'done' && event.success && event.acceptance?.ready)) setAgentTab('result')
      if (['tool_start', 'user_input_required', 'approval_required', 'waiting_user'].includes(event.type)) setAgentTab('conversation')
      if (event.type === 'error') toast.show(event.message, 'error')
    })
    return off
  }, [
    applyGeneratedPackage,
    editDraft,
    transitionRun,
    toast,
    updateAgentSessionId,
    updateAgentStatus,
    updatePendingApproval,
    updatePendingUserRequest
  ])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await readStableAgentSnapshot()
        if (cancelled || !snapshot || localAgentOperationRef.current) return
        if (!shouldApplyInitialPluginDevSnapshot(snapshot.result.status)) {
          transitionRun({ type: 'patch', patch: { hasAgentHistory: true } })
          return
        }
        applyAgentSnapshot(snapshot)
      } catch {
        // Restoring a prior session is best-effort; live events remain authoritative.
      } finally {
        initialSnapshotPendingRef.current = false
      }
    })()
    return () => { cancelled = true }
  }, [applyAgentSnapshot, readStableAgentSnapshot, transitionRun])

  const resetAgentUi = useCallback((): void => {
    snapshotGateRef.current.observeMutation()
    agentSessionIdRef.current = null
    agentStatusRef.current = null
    pendingApprovalRef.current = null
    pendingUserRequestRef.current = null
    transitionRun({ type: 'reset' })
    setAgentTab('conversation')
  }, [transitionRun])

  const applyLoadedPackage = useCallback((pkg: ScraperPluginPackage): void => {
    const identity = pluginDevLoadedPluginIdentity(pkg.name, 'user')
    loadDraft(pkg)
    setInstalledBaseline(fingerprintPluginPackage(pkg))
    setSelectedPluginName(identity.selectedPluginName)
    setLoadedInstalledName(identity.loadedInstalledName)
    setForkedFromBuiltIn(identity.forkedFromBuiltIn)
    setDryRun(null)
    setDryRunPackageFingerprint(null)
    resetAgentUi()
    setFeedbackText('')
  }, [loadDraft, resetAgentUi])

  const resetToNewPlugin = (nextKind: PluginKind): void => {
    resetDraft(nextKind)
    setSelectedPluginName('')
    setLoadedInstalledName(null)
    setForkedFromBuiltIn(null)
    setInstalledBaseline(null)
    setDryRun(null)
    setDryRunPackageFingerprint(null)
    resetAgentUi()
    setFeedbackText('')
    setShowCodeModal(false)
  }

  useEffect(() => {
    void refreshUserPlugins(kind)
  }, [kind, refreshUserPlugins])

  const loadInstalledPlugin = async (name: string): Promise<void> => {
    if (pluginsLoading || busy !== null) return
    setPluginsLoading(true)
    try {
      const pkg =
        kind === 'video'
          ? await api.scrape.getPluginPackage(name)
          : await api.actressScrape.getPluginPackage(name)
      const source = selectablePlugins.find((plugin) => plugin.name === name)?.source
      if (source === 'builtin') {
        const identity = pluginDevLoadedPluginIdentity(pkg.name, source)
        const forkedName = suggestForkedPluginName(
          pkg.name,
          selectablePlugins.map((plugin) => plugin.name)
        )
        applyLoadedPackage({ ...pkg, name: forkedName })
        setLoadedInstalledName(identity.loadedInstalledName)
        setForkedFromBuiltIn(identity.forkedFromBuiltIn)
        setSelectedPluginName(identity.selectedPluginName)
        toast.show(
          `已载入内置插件「${pkg.name}」为草稿「${forkedName}」，安装时不会覆盖内置插件`,
          'info'
        )
        return
      }
      applyLoadedPackage(pkg)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginsLoading(false)
    }
  }

  const buildPackage = useCallback((): ScraperPluginPackage => ({
    schemaVersion: 1,
    kind,
    name: siteName.trim() || derivePluginNameFromUrl(siteUrl, kind),
    version: version.trim() || '1.0.0',
    description: description.trim(),
    author: author.trim() || undefined,
    homepage: siteUrl.trim() || undefined,
    supportedFields: supportedFieldIds as Array<VideoScrapeField | ActressScrapeField>,
    code
  }), [author, code, description, kind, siteName, siteUrl, supportedFieldIds, version])

  const hasUninstalledChanges = useMemo(() => {
    if (!hasPackage) return false
    const current = fingerprintPluginPackage(buildPackage())
    if (installedBaseline) return current !== installedBaseline
    return true
  }, [buildPackage, hasPackage, installedBaseline])

  const currentRuntimeFingerprint = hasPackage ? fingerprintPluginRuntime(buildPackage()) : null
  const resultStale =
    (Boolean(dryRun && dryRunPackageFingerprint && currentRuntimeFingerprint) &&
      dryRunPackageFingerprint !== currentRuntimeFingerprint) ||
    (Boolean(execution && executionPackageFingerprint && currentRuntimeFingerprint) &&
      executionPackageFingerprint !== currentRuntimeFingerprint)
  const installState: 'not-installed' | 'dirty' | 'synced' = installedBaseline
    ? hasUninstalledChanges
      ? 'dirty'
      : 'synced'
    : hasPackage
      ? 'not-installed'
      : 'not-installed'
  const resultCount = execution?.cases.length ?? dryRun?.cases?.length ?? (dryRun ? 1 : 0)
  const canInstallCurrentDraft = canInstallPluginDevDraft({
    hasUninstalledChanges,
    hasAgentSession: Boolean(agentSessionId),
    checkReady: acceptance?.ready === true,
    resultStale
  })
  const currentArtifactReady = acceptance?.ready === true && !resultStale
  const continuationNeedsFeedback = requiresPluginDevContinuationFeedback({
    canResumeAgent,
    artifactReady: currentArtifactReady,
    feedbackText
  })
  const agentPrimaryDisabledReason =
    pendingApproval
      ? '请先在运行记录中批准或拒绝当前操作。'
      : pendingUserRequest
        ? '请先在运行记录中完成当前结构化请求。'
        : continuationNeedsFeedback
          ? '当前版本已可安装；如需继续完善，请先在右侧输入具体反馈。'
          : null

  useEffect(() => {
    packageFingerprintRef.current = currentRuntimeFingerprint
  }, [currentRuntimeFingerprint])

  const needsLeaveConfirm = hasUninstalledChanges || activeAgent
  const leaveConfirmMessage = activeAgent
    ? hasUninstalledChanges
      ? 'Agent 仍在运行或等待操作；离开后可回来恢复，但插件还有未安装更改。'
      : 'Agent 仍在运行或等待操作；离开页面不会终止会话，可稍后回来恢复。'
    : installedBaseline
      ? '插件代码已变更但尚未重新安装，离开后将无法在刮削中使用新版本。'
      : '插件尚未安装，离开后将无法在刮削中使用。'

  useEffect(() => {
    leaveGuard.setNeedsConfirm(needsLeaveConfirm)
    leaveGuard.setMessage(leaveConfirmMessage)
  }, [needsLeaveConfirm, leaveConfirmMessage, leaveGuard])

  useEffect(() => {
    if (!loadPackage) return
    applyLoadedPackage(loadPackage)
    onLoadConsumedRef.current()
  }, [applyLoadedPackage, loadPackage])

  const runGuardedAction = (action: () => void): void => {
    if (hasUninstalledChanges) {
      leaveGuard.requestLeave(action)
      return
    }
    action()
  }

  const handleSelectPlugin = (name: string): void => {
    if (shouldIgnorePluginDevSelection({
      nextName: name,
      selectedName: selectedPluginName,
      hasLoadedPlugin: Boolean(loadedInstalledName || forkedFromBuiltIn)
    })) return
    runGuardedAction(() => {
      if (!name) {
        resetToNewPlugin(kind)
        return
      }
      void loadInstalledPlugin(name)
    })
  }

  const changeKind = (next: PluginKind): void => {
    if (next === kind) return
    runGuardedAction(() => resetToNewPlugin(next))
  }

  const buildAgentInput = (mode: 'create' | 'debug' | 'feedback') => {
    const pkg = buildPackage()
    const targets = resolvedTestTargets
    return {
      kind: pkg.kind,
      siteName: pkg.name,
      siteUrl: pkg.homepage,
      description: pkg.description || undefined,
      // Create mode has no requested field scope. The workspace starts with an
      // empty declaration and Pi derives the final fields from the exact page.
      supportedFields: mode === 'create' ? [] : (pkg.supportedFields ?? allFields),
      testTargets: targets.length > 0 ? targets : undefined
    }
  }

  const openConnectionModal = (): void => {
    setShowConnectionModal(true)
  }

  const canCancelAgent = busy === 'agent' && agentSessionId !== null
  const canClearAgentHistory = canClearPluginDevAgentHistory({
    hasHistory: hasAgentHistory,
    status: agentStatus,
    busy: busy !== null
  })

  const cancelAgent = (): void => {
    const sessionId = agentSessionIdRef.current
    if (!sessionId) return
    if (busy !== 'agent') return
    void api.pluginDev.cancel(sessionId)
    snapshotGateRef.current.observeMutation()
    updateAgentStatus('cancelled')
    updatePendingApproval(null)
    transitionRun({ type: 'patch', patch: { activeTool: null } })
    if (!localAgentOperationRef.current) setBusy(null)
  }

  const startAgent = async (mode: 'create' | 'debug' | 'feedback', userMessage?: string): Promise<boolean> => {
    if (busy || !canUseAgent) return false
    if (mode !== 'create' && resolvedTestTargets.length === 0) {
      toast.show(kindProfile.aiDebugNeedsTargetMessage, 'error')
      return false
    }
    const priorDryRun = dryRun
    const operation = beginLocalAgentOperation('start', null)
    setBusy('agent')
    resetAgentUi()
    setAgentTab('conversation')
    if (userMessage?.trim()) {
      transitionRun({ type: 'patch', patch: { conversationItems: [{ id: nextConversationId('user'), type: 'user', text: userMessage.trim() }] } })
    }
    updateAgentStatus('running')
    try {
      const result = await api.pluginDev.start({
        ...buildAgentInput(mode),
        mode,
        userMessage: userMessage?.trim(),
        package: mode === 'create' && !code.trim() ? undefined : buildPackage()
      })
      if (localAgentOperationRef.current?.id === operation.id) {
        localAgentOperationRef.current = { ...operation, sessionId: result.sessionId }
      }
      updateAgentSessionId(result.sessionId)
      updateAgentStatus(result.status)
      applyGeneratedPackage(result.package)
      editDraft({ testTarget: result.runTargets.map(runTargetLabel).join('\n') })
      transitionRun({ type: 'patch', patch: {
        frozenModel: result.frozenModel ?? null, execution: result.execution ?? null, acceptance: result.acceptance ?? null,
        executionPackageFingerprint: result.execution ? fingerprintPluginRuntime(result.package) : null
      } })
      if (priorDryRun) setDryRun(priorDryRun)
      if (shouldOpenResultAfterAgentDone(
        result.status,
        result.execution,
        result.acceptance
      )) setAgentTab('result')
      if (result.status === 'waiting_user') {
        transitionRun({ type: 'patch', patch: { waitingUserReason: result.summary } })
        setAgentTab(result.acceptance?.ready ? 'result' : 'conversation')
      }
      transitionRun({ type: 'patch', patch: (state) => ({ conversationItems: [
        ...state.conversationItems.slice(-119),
        { id: nextConversationId('agent'), type: 'agent', text: result.summary }
      ] }) })
      const toastInfo = pluginDevAgentEndNotice(result.status, result.acceptance?.ready === true)
      toast.show(toastInfo.message, toastInfo.kind)
      return true
    } catch (e) {
      updateAgentStatus('failed')
      toast.show(String((e as Error).message), 'error')
      return false
    } finally {
      finishLocalAgentOperation(operation)
    }
  }

  const continueAgent = async (
    text: string,
    approvalDecision?: PluginDevAgentMessageInput['approvalDecision'],
    userResponse?: PluginDevUserResponse,
    continuationKind: NonNullable<PluginDevAgentMessageInput['continuationKind']> = 'user_feedback'
  ): Promise<boolean> => {
    const sessionId = agentSessionIdRef.current
    if (busy || !sessionId) return false
    const dispatch = checkPluginDevMessageDispatch(pendingApprovalRef.current, approvalDecision)
    if (!dispatch.allowed) {
      toast.show(
        dispatch.reason === 'approval-required'
          ? '请先批准或拒绝当前操作，再继续发送消息。'
          : '审批请求已变化，请按当前审批提示重新操作。',
        'info'
      )
      return false
    }
    const pendingRequest = pendingUserRequestRef.current
    if (pendingRequest && (!userResponse || userResponse.requestId !== pendingRequest.requestId)) {
      toast.show('请使用当前请求提供的控件完成响应。', 'info')
      return false
    }
    if (!pendingRequest && userResponse) {
      toast.show('该用户请求已处理或已过期。', 'info')
      return false
    }

    const operation = beginLocalAgentOperation('message', sessionId)
    if (dispatch.approval) updatePendingApproval(null)
    if (userResponse) updatePendingUserRequest(null)
    setBusy('agent')
    transitionRun({ type: 'patch', patch: (state) => ({ conversationItems: [...state.conversationItems.slice(-119), { id: nextConversationId('user'), type: 'user', text }] }) })
    updateAgentStatus('running')
    setAgentTab('conversation')
    transitionRun({ type: 'patch', patch: { waitingUserReason: null } })
    try {
      const result = await api.pluginDev.message({
        sessionId,
        text,
        continuationKind,
        approvalDecision,
        userResponse
      })
      updateAgentStatus(result.status)
      applyGeneratedPackage(result.package)
      editDraft({ testTarget: result.runTargets.map(runTargetLabel).join('\n') })
      transitionRun({ type: 'patch', patch: {
        frozenModel: result.frozenModel ?? null, execution: result.execution ?? null, acceptance: result.acceptance ?? null,
        executionPackageFingerprint: result.execution ? fingerprintPluginRuntime(result.package) : null
      } })
      if (shouldOpenResultAfterAgentDone(
        result.status,
        result.execution,
        result.acceptance
      )) setAgentTab('result')
      if (result.status === 'waiting_user') transitionRun({ type: 'patch', patch: { waitingUserReason: result.summary } })
      transitionRun({ type: 'patch', patch: (state) => ({ conversationItems: [
        ...state.conversationItems.slice(-119),
        { id: nextConversationId('agent'), type: 'agent', text: result.summary }
      ] }) })
      const toastInfo =
        result.status === 'completed'
          ? { message: 'Agent 继续完成', kind: 'success' as const }
          : pluginDevAgentEndNotice(result.status, result.acceptance?.ready === true)
      toast.show(toastInfo.message, toastInfo.kind)
      return true
    } catch (e) {
      if (dispatch.approval || userResponse) {
        try {
          const snapshot = await readStableAgentSnapshot(sessionId)
          if (snapshot) {
            applyAgentSnapshot(snapshot)
          } else {
            updatePendingApproval(null)
            updateAgentStatus('failed')
          }
        } catch {
          updatePendingApproval(null)
          updateAgentStatus('failed')
        }
      } else {
        updateAgentStatus('failed')
      }
      toast.show(String((e as Error).message), 'error')
      return false
    } finally {
      finishLocalAgentOperation(operation)
    }
  }

  const sendAgentFeedback = async (): Promise<void> => {
    const feedback = feedbackText.trim()
    if (busy || !canUseAgent || !hasPackage || !feedback) return
    if (pendingApprovalRef.current) {
      toast.show('请先批准或拒绝当前操作，再发送反馈。', 'info')
      return
    }
    const pendingRequest = pendingUserRequestRef.current
    if (pendingRequest && pendingRequest.type !== 'freeform') {
      toast.show('请先使用当前请求提供的按钮完成响应。', 'info')
      return
    }
    if (!canResumeAgent && resolvedTestTargets.length === 0) {
      toast.show(kindProfile.aiDebugNeedsTargetMessage, 'error')
      return
    }
    if (canResumeAgent) {
      const response: PluginDevUserResponse | undefined = pendingRequest?.type === 'freeform'
        ? { requestId: pendingRequest.requestId, type: 'freeform', text: feedback }
        : undefined
      if (await continueAgent(feedback, undefined, response)) setFeedbackText('')
      return
    }
    if (
      await startAgent(
        loadedInstalledName || forkedFromBuiltIn ? 'debug' : 'feedback',
        feedback
      )
    ) {
      setFeedbackText('')
    }
  }

  const continueAfterBrowserInteraction = async (): Promise<void> => {
    const request = pendingUserRequestRef.current
    if (request?.type !== 'browser_interaction') return
    await continueAgent('已完成浏览器中的必要操作', undefined, {
      requestId: request.requestId,
      type: 'browser_interaction',
      action: 'completed'
    })
  }

  const resolveFieldMapping = async (optionId: string): Promise<void> => {
    const request = pendingUserRequestRef.current
    if (request?.type !== 'choice') return
    const option = request.options.find((item) => item.id === optionId)
    if (!option) return
    await continueAgent(`选择「${option.label}」`, undefined, {
      requestId: request.requestId,
      type: 'choice',
      optionId
    })
  }

  const decideApproval = async (decision: 'approve' | 'deny'): Promise<void> => {
    const approval = pendingApprovalRef.current
    if (!approval) return
    await continueAgent(
      decision === 'approve'
        ? `用户已批准 ${approval.tool}，请重试该操作。`
        : `用户已拒绝 ${approval.tool}，请不要执行该操作。`,
      { requestId: approval.requestId, decision }
    )
  }

  const runPrimaryAgentAction = async (): Promise<void> => {
    if (feedbackPending && canSendAgentFeedback) {
      await sendAgentFeedback()
      return
    }
    if (continuationNeedsFeedback) {
      toast.show('如需继续完善，请先输入具体反馈。', 'info')
      return
    }
    if (canResumeAgent) {
      await continueAgent('请继续当前插件开发/调试任务。', undefined, undefined, 'resume')
      return
    }
    const debuggingExisting = Boolean(loadedInstalledName || forkedFromBuiltIn)
    const mode: 'create' | 'debug' | 'feedback' = !hasPackage
      ? 'create'
      : debuggingExisting
        ? 'debug'
        : 'feedback'
    await startAgent(mode)
  }

  const install = async (): Promise<void> => {
    if (busy || !hasPackage || !hasUninstalledChanges) return
    if (!canInstallCurrentDraft) {
      toast.show('当前 Agent 草稿尚未通过机械验收，不能安装。', 'info')
      return
    }
    setBusy('install')
    try {
      const packageToInstall = buildPackage()
      const descriptor = await api.pluginDev.install({
        package: packageToInstall,
        overwriteUser: loadedInstalledName === packageToInstall.name,
        sessionId: agentSessionId ?? undefined
      })
      await onInstalled(kind)
      setLoadedInstalledName(descriptor.name)
      setForkedFromBuiltIn(null)
      setSelectedPluginName(descriptor.name)
      editDraft({ siteName: descriptor.name })
      setInstalledBaseline(fingerprintPluginPackage({
        ...packageToInstall,
        name: descriptor.name
      }))
      if (agentSessionId) {
        updateAgentStatus('completed')
        transitionRun({ type: 'patch', patch: { agentPhase: 'ready' } })
        transitionRun({ type: 'patch', patch: { waitingUserReason: null } })
      }
      void refreshUserPlugins(kind)
      toast.show(
        loadedInstalledName ? `已更新安装自定义插件：${descriptor.name}` : `已安装自定义插件：${descriptor.name}`,
        'success'
      )
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusy(null)
    }
  }

  const exportAgentWorkLog = async (): Promise<void> => {
    if (!agentSessionId || exportWorkLogBusy) return
    setExportWorkLogBusy(true)
    try {
      const savedPath = await api.pluginDev.exportWorkLog(agentSessionId)
      if (savedPath) toast.show(`已导出工作日志：${savedPath}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setExportWorkLogBusy(false)
    }
  }

  const clearAgentHistory = async (): Promise<void> => {
    if (!canClearAgentHistory) return
    setBusy('clear-history')
    try {
      const cleared = await api.pluginDev.clearHistory()
      localAgentOperationRef.current = null
      latestSnapshotCursorRef.current = -1
      initialSnapshotPendingRef.current = false
      resetToNewPlugin(kind)
      transitionRun({ type: 'patch', patch: { hasAgentHistory: false } })
      setShowClearHistoryModal(false)
      toast.show(
        cleared > 0 ? `已清除 ${cleared} 个历史会话，并回到新建插件` : '已回到新建插件',
        'success'
      )
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusy(null)
    }
  }

  const statusTone =
    agentStatus === 'running'
      ? 'running'
      : agentStatus === 'waiting_user'
        ? currentArtifactReady ? 'ok' : 'waiting'
        : agentStatus === 'completed'
          ? 'ok'
        : agentStatus === 'failed'
          ? 'fail'
          : agentStatus === 'cancelled'
            ? 'cancelled'
            : undefined

  return (
    <WorkbenchShell className={`${styles.shell}${presentation === 'settings' ? ` ${styles.shellSettings}` : ''}`}>
      <nav className={styles.breadcrumb} aria-label="当前位置">
        <button
          type="button"
          className={styles.backLink}
          onClick={() => leaveGuard.requestLeave(() => navigate(settingsPath('overview')))}
        >
          设置
        </button>
        <span>/</span>
        <button
          type="button"
          className={styles.backLink}
          onClick={() =>
            leaveGuard.requestLeave(() =>
              navigate(settingsPath('plugins', 'video'))
            )
          }
        >
          刮削插件
        </button>
        <span>/</span>
        <strong>开发助手</strong>
      </nav>

      <WorkbenchToolbar className={styles.toolbar}>
        <div className={styles.toolbarStart}>
          <div
            className={`${styles.kindToggle} ${styles.toolbarKindToggle}`}
            role="group"
            aria-label="插件类型"
          >
            <button
              type="button"
              className={`${styles.kindButton}${kind === 'video' ? ` ${styles.kindButtonActive}` : ''}`}
              disabled={busy !== null}
              onClick={() => changeKind('video')}
            >
              影片
            </button>
            <button
              type="button"
              className={`${styles.kindButton}${kind === 'actress' ? ` ${styles.kindButtonActive}` : ''}`}
              disabled={busy !== null}
              onClick={() => changeKind('actress')}
            >
              演员
            </button>
          </div>
          <WorkbenchStatusPill className={styles.statusPill} data-status={statusTone}>
            {agentStatusLabel(agentStatus, agentStep, currentArtifactReady)}
          </WorkbenchStatusPill>
        </div>
        <div className={styles.toolbarActions}>
          <PluginSourceBadge source="user">
            {activeLlmModelLabel || '未配置模型'}
          </PluginSourceBadge>
          <span className={styles.codeActionSlot}>
            {code.trim().length > 0 ? (
              <IconButton
                className={styles.toolbarIconButton}
                icon={<Code2 {...UI_ICON_MD} />}
                label="查看代码"
                disabled={busy !== null}
                onClick={() => setShowCodeModal(true)}
              />
            ) : (
              <span className={styles.toolbarIconPlaceholder} aria-hidden="true" />
            )}
          </span>
          <IconButton
            className={styles.toolbarIconButton}
            icon={<Settings {...UI_ICON_MD} />}
            label="连接设置"
            disabled={busy !== null}
            onClick={openConnectionModal}
          />
        </div>
      </WorkbenchToolbar>

      <WorkbenchMain className={`${styles.main} ${styles.mainAgentFocus}${presentation === 'settings' ? ` ${styles.mainSettings}` : ''}`}>
        <PluginDevConfigRail
          kind={kind}
          siteName={siteName}
          siteUrl={siteUrl}
          testTarget={testTarget}
          description={description}
          version={version}
          author={author}
          supportedFields={supportedFieldIds}
          fieldLabel={fieldLabelForKind}
          loadedInstalledName={loadedInstalledName}
          selectedPluginName={selectedPluginName}
          selectablePlugins={selectablePlugins}
          forkedFromBuiltIn={forkedFromBuiltIn}
          pluginsLoading={pluginsLoading}
          busy={busy !== null}
          canUseAgent={canResumeAgent ? canUseAgent : canStartAgent}
          hasPackage={hasPackage}
          canResumeAgent={canResumeAgent}
          agentCompleted={agentStatus === 'completed'}
          agentReady={currentArtifactReady}
          feedbackPending={feedbackPending}
          agentDisabledReason={agentDisabledReason}
          agentPrimaryDisabledReason={agentPrimaryDisabledReason}
          activeLlmReady={llmReady}
          agentBusy={busy === 'agent'}
          installBusy={busy === 'install'}
          canInstall={canInstallCurrentDraft}
          onSelectPlugin={handleSelectPlugin}
          onStartAgent={() => void runPrimaryAgentAction()}
          onInstall={() => void install()}
          onSiteNameChange={(value) => editDraft({ siteName: value })}
          onSiteUrlChange={(value) => editDraft({ siteUrl: value })}
          onTestTargetChange={(value) => editDraft({ testTarget: value })}
          onDescriptionChange={(value) => editDraft({ description: value })}
          onVersionChange={(value) => editDraft({ version: value })}
          onAuthorChange={(value) => editDraft({ author: value })}
          onSupportedFieldsChange={(value) => editDraft({ supportedFieldIds: value })}
        />

        <PluginDevAgentRail
          kind={kind}
          tab={agentTab}
          conversationCount={conversationItems.length}
          resultCount={resultCount}
          agentStatus={agentStatus}
          agentPhase={agentPhase}
          agentStep={agentStep}
          contextStats={contextStats}
          activeTool={activeTool}
          conversationItems={conversationItems}
          dryRun={dryRun}
          execution={execution}
          acceptance={acceptance}
          resultStale={resultStale}
          installState={installState}
          waitingUserReason={waitingUserReason}
          artifactReady={currentArtifactReady}
          pendingApproval={pendingApproval}
          pendingUserRequest={pendingUserRequest}
          feedbackText={feedbackText}
          busy={busy !== null}
          canSend={canSendAgentFeedback}
          canCancelAgent={canCancelAgent}
          canClearHistory={canClearAgentHistory}
          clearHistoryBusy={busy === 'clear-history'}
          canExportWorkLog={Boolean(agentSessionId)}
          exportWorkLogBusy={exportWorkLogBusy}
          onTabChange={setAgentTab}
          onFeedbackChange={setFeedbackText}
          onSend={() => void sendAgentFeedback()}
          onCancelAgent={cancelAgent}
          onClearHistory={() => setShowClearHistoryModal(true)}
          onContinueBrowserInteraction={() => void continueAfterBrowserInteraction()}
          onFieldMapping={(optionId) => void resolveFieldMapping(optionId)}
          onApprovalDecision={(decision) => void decideApproval(decision)}
          onExportWorkLog={() => void exportAgentWorkLog()}
        />
      </WorkbenchMain>

      {showConnectionModal && (
        <PluginDevConnectionModal
          workloadLabel="插件开发 Agent"
          providerLabel={activeLlmProviderLabel}
          modelLabel={activeLlmModelLabel}
          revision={frozenModel?.revision ?? modelManagement?.revision ?? '—'}
          frozen={Boolean(frozenModel)}
          error={llmReady ? null : llmReason}
          onOpenModelSettings={() => {
            setShowConnectionModal(false)
            leaveGuard.requestLeave(() => navigate(settingsPath('models', 'providers')))
          }}
          onClose={() => setShowConnectionModal(false)}
        />
      )}

      {showClearHistoryModal && (
        <ConfirmModal
          title="清除会话并回到新建插件？"
          confirmText={busy === 'clear-history' ? '清除中…' : '清除会话'}
          danger
          busy={busy === 'clear-history'}
          onConfirm={() => void clearAgentHistory()}
          onCancel={() => setShowClearHistoryModal(false)}
        >
          <p>
            将关闭全部历史会话，清空对话、dry-run 和验证结果，并把左侧未安装草稿恢复为「新建插件」空表单；下次进入时不会再自动恢复。
            已经安装到应用里的插件不会被删除。
          </p>
        </ConfirmModal>
      )}

      {showCodeModal && (
        <PluginDevCodeModal
          kind={kind}
          code={code}
          pluginName={siteName.trim()}
          onClose={() => setShowCodeModal(false)}
        />
      )}
    </WorkbenchShell>
  )
}
