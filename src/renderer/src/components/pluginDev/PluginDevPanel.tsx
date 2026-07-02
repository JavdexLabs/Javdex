import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { findLlmProviderViewModel, listModelsForProvider } from '@shared/llmProviders'
import type {
  AppSettings,
  ActressScrapeField,
  PluginDevAgentContextStats,
  PluginDevAgentEvent,
  PluginDevAgentPhase,
  PluginDevDryRunResult,
  PluginDevSessionStatus,
  PluginDevVerificationReport,
  ScraperPluginPackage,
  VideoScrapeField
} from '@shared/types'
import { api } from '../../api'
import { settingsPath } from '../../settings/settingsRoutes'
import { useToast } from '../Toast'
import PluginDevAgentRail from './PluginDevAgentRail'
import PluginDevCodeModal from './PluginDevCodeModal'
import PluginDevConnectionModal from './PluginDevConnectionModal'
import PluginDevConfigRail from './PluginDevConfigRail'
import { usePluginDevLeaveGuard } from './PluginDevLeaveGuard'
import { fingerprintPluginPackage } from './pluginDevPackageSnapshot'
import { agentStatusLabel, type PluginDevAgentTab, type PluginDevConversationItem, type PluginKind } from './types'
import {
  allFieldsForKind,
  fieldLabelForKind,
  getPluginDevKindProfile,
  parseTestTargetList,
  testTargetsFromDryRun
} from '@shared/pluginDevKindProfile'

let conversationSeq = 0
function nextConversationId(prefix: string): string {
  conversationSeq += 1
  return `${prefix}:${conversationSeq}`
}

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
  dryRun: PluginDevDryRunResult | undefined | null
): boolean {
  return status === 'completed' && dryRun?.ok === true
}

function isActiveAgentSessionStatus(status: PluginDevSessionStatus | null): boolean {
  return status === 'running' || status === 'waiting_user'
}

function llmUnavailableReason(
  provider: ReturnType<typeof findLlmProviderViewModel> | undefined,
  modelLabel: string
): string | null {
  if (!provider) return '未配置默认模型，先到模型设置选择一个 Agent 可用供应商。'
  if (provider.agentCompatible !== true) return `${provider.name} 暂不支持工具调用，不能用于插件开发 Agent。`
  if (provider.status !== 'ready') return `${provider.name} 尚未就绪，请检查 API Key 与模型配置。`
  if (!modelLabel) return '未选择默认模型。'
  return null
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

export default function PluginDevPanel({
  settings,
  setSettings,
  onInstalled,
  loadPackage,
  onLoadConsumed
}: {
  settings: AppSettings
  setSettings: (settings: AppSettings) => void
  onInstalled: (kind: PluginKind) => Promise<void>
  loadPackage: ScraperPluginPackage | null
  onLoadConsumed: () => void
}): JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const leaveGuard = usePluginDevLeaveGuard()
  const [maxAgentSteps, setMaxAgentSteps] = useState(settings.pluginDevAgentMaxSteps)
  const [maxContextTokens, setMaxContextTokens] = useState(settings.pluginDevAgentMaxContextTokens)
  const [showConnectionModal, setShowConnectionModal] = useState(false)
  const [showCodeModal, setShowCodeModal] = useState(false)
  const [agentTab, setAgentTab] = useState<PluginDevAgentTab>('conversation')
  const [kind, setKind] = useState<PluginKind>('video')
  const [siteName, setSiteName] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [testTarget, setTestTarget] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [author, setAuthor] = useState('Plugin Dev Agent')
  const [supportedFieldIds, setSupportedFieldIds] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'save-key' | 'agent' | 'install' | null>(null)
  const [dryRun, setDryRun] = useState<PluginDevDryRunResult | null>(null)
  const [dryRunPackageFingerprint, setDryRunPackageFingerprint] = useState<string | null>(null)
  const [verification, setVerification] = useState<PluginDevVerificationReport | null>(null)
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [agentStatus, setAgentStatus] = useState<PluginDevSessionStatus | null>(null)
  const [agentPhase, setAgentPhase] = useState<PluginDevAgentPhase>('idle')
  const [agentStep, setAgentStep] = useState(0)
  const [contextStats, setContextStats] = useState<PluginDevAgentContextStats | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [conversationItems, setConversationItems] = useState<PluginDevConversationItem[]>([])
  const [waitingUserReason, setWaitingUserReason] = useState<string | null>(null)
  const [loadedInstalledName, setLoadedInstalledName] = useState<string | null>(null)
  const [installedBaseline, setInstalledBaseline] = useState<string | null>(null)
  const [selectedPluginName, setSelectedPluginName] = useState('')
  const [userPluginNames, setUserPluginNames] = useState<string[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const agentSessionIdRef = useRef<string | null>(null)
  const agentStatusRef = useRef<PluginDevSessionStatus | null>(null)
  const isAgentRunningRef = useRef(false)
  const packageFingerprintRef = useRef<string | null>(null)

  const allFields = allFieldsForKind(kind)
  const kindProfile = useMemo(() => getPluginDevKindProfile(kind), [kind])
  const testTargets = useMemo(() => parseTestTargetList(testTarget), [testTarget])
  const resolvedTestTargets = useMemo(() => {
    if (testTargets.length > 0) return testTargets
    return testTargetsFromDryRun(kind, dryRun)
  }, [kind, testTargets, dryRun])
  const canResumeAgent = canResumeAgentSession(agentSessionId, agentStatus)
  const hasPackage = (siteName.trim().length > 0 || siteUrl.trim().length > 0) && code.trim().length > 0
  const activeLlmProvider = useMemo(
    () => findLlmProviderViewModel(settings, settings.defaultLlmProviderId),
    [settings]
  )
  const activeLlmModelLabel = useMemo(() => {
    const models = listModelsForProvider(settings.defaultLlmProviderId, settings.llmCustomModels)
    return models.find((model) => model.id === settings.defaultLlmModelId)?.name ?? settings.defaultLlmModelId
  }, [settings.defaultLlmModelId, settings.defaultLlmProviderId, settings.llmCustomModels])
  const llmReady = activeLlmProvider?.agentCompatible === true && activeLlmProvider.status === 'ready'
  const llmReason = llmUnavailableReason(activeLlmProvider, activeLlmModelLabel)
  const canUseAgent =
    llmReady &&
    (loadedInstalledName ? siteName.trim().length > 0 : siteUrl.trim().length > 0)
  const hasTestTarget = resolvedTestTargets.length > 0
  const feedbackPending = feedbackText.trim().length > 0
  const canStartAgent = canUseAgent && (!hasPackage || hasTestTarget)
  const canSendAgentFeedback = canUseAgent && hasPackage && (hasTestTarget || canResumeAgent)
  const activeAgent = busy === 'agent' || isActiveAgentSessionStatus(agentStatus)
  const agentPrimaryDisabledReason =
    agentStatus === 'completed' && canResumeAgent && !feedbackPending
      ? '任务已完成；如需继续修改，请先在右侧输入反馈。'
      : null
  const agentDisabledReason = !canUseAgent
    ? llmReason || (loadedInstalledName ? '请先选择或填写插件名。' : '请先填写网站主页。')
    : hasPackage && !hasTestTarget && !canResumeAgent
      ? kindProfile.aiDebugNeedsTargetMessage
      : null

  useEffect(() => {
    setMaxAgentSteps(settings.pluginDevAgentMaxSteps)
    setMaxContextTokens(settings.pluginDevAgentMaxContextTokens)
  }, [settings.pluginDevAgentMaxSteps, settings.pluginDevAgentMaxContextTokens])

  useEffect(() => {
    agentSessionIdRef.current = agentSessionId
  }, [agentSessionId])

  useEffect(() => {
    agentStatusRef.current = agentStatus
  }, [agentStatus])

  useEffect(() => {
    return () => {
      const sessionId = agentSessionIdRef.current
      if (!sessionId) return
      const active =
        isAgentRunningRef.current || isActiveAgentSessionStatus(agentStatusRef.current)
      if (!active) return
      void api.pluginDev.cancel(sessionId)
      isAgentRunningRef.current = false
    }
  }, [])

  useEffect(() => {
    const off = api.pluginDev.onAgentEvent((event: PluginDevAgentEvent) => {
      if (isAgentRunningRef.current) {
        agentSessionIdRef.current = event.sessionId
        setAgentSessionId(event.sessionId)
      } else if (agentSessionIdRef.current && event.sessionId !== agentSessionIdRef.current) {
        return
      }

      if (event.type === 'step_start') {
        setAgentStep(event.step)
        setActiveTool(null)
      }
      if (event.type === 'phase_updated') {
        setAgentPhase(event.phase)
        setAgentStep(event.step)
      }
      if (event.type === 'context_updated') {
        setAgentStep(event.step)
        setContextStats(event.stats)
      }
      if (event.type === 'tool_start') {
        setAgentStep(event.step)
        setActiveTool(event.tool)
        setAgentTab('conversation')
      }
      if (event.type === 'assistant_text') {
        setConversationItems((prev) => [
          ...prev,
          { id: nextConversationId('agent'), type: 'agent', text: event.text }
        ])
      }
      if (event.type === 'tool_result') {
        setAgentStep(event.step)
        setActiveTool(null)
        setConversationItems((prev) => [
          ...prev.slice(-120),
          {
            id: nextConversationId(`tool:${event.step}:${event.tool}`),
            type: 'tool',
            step: event.step,
            tool: event.tool,
            summary: event.summary,
            detail: event.detail,
            ok: event.ok
          }
        ])
      }
      if (event.type === 'package_updated') {
        applyGeneratedPackage(event.package)
      }
      if (event.type === 'plugin_installed') {
        applyGeneratedPackage(event.package)
        setLoadedInstalledName(event.descriptor.name)
        setSelectedPluginName(event.descriptor.name)
        setInstalledBaseline(fingerprintPluginPackage(event.package))
        void onInstalled(event.package.kind)
        void refreshUserPlugins(event.package.kind)
        toast.show(`已安装自定义插件：${event.descriptor.name}`, 'success')
      }
      if (event.type === 'dry_run_updated') {
        setDryRun(event.dryRun)
        setDryRunPackageFingerprint(packageFingerprintRef.current)
        setVerification(null)
      }
      if (event.type === 'verification_updated') {
        setVerification(event.verification)
        setAgentTab('result')
      }
      if (event.type === 'waiting_user') {
        setAgentStatus('waiting_user')
        setWaitingUserReason(event.reason)
        setAgentTab('conversation')
      }
      if (event.type === 'done') {
        setActiveTool(null)
        if (event.dryRun) setDryRun(event.dryRun)
        if (event.dryRun) setDryRunPackageFingerprint(fingerprintPluginPackage(event.package))
        if (event.verification) setVerification(event.verification)
        if (event.success && event.dryRun?.ok) setAgentTab('result')
      }
      if (event.type === 'error') {
        setActiveTool(null)
        setAgentStatus('failed')
        setConversationItems((prev) => [
          ...prev,
          { id: nextConversationId('agent:error'), type: 'agent', text: event.message }
        ])
        toast.show(event.message, 'error')
      }
    })
    return off
  }, [toast])

  const resetAgentUi = (): void => {
    setAgentSessionId(null)
    setAgentStatus(null)
    setAgentPhase('idle')
    setAgentStep(0)
    setContextStats(null)
    setActiveTool(null)
    setWaitingUserReason(null)
    setVerification(null)
    setConversationItems([])
    setAgentTab('conversation')
  }

  const applyLoadedPackage = (pkg: ScraperPluginPackage): void => {
    setKind(pkg.kind)
    setSiteName(pkg.name)
    setVersion(pkg.version ?? '1.0.0')
    setDescription(pkg.description ?? '')
    setAuthor(pkg.author ?? 'Plugin Dev Agent')
    setSiteUrl(pkg.homepage ?? '')
    setCode(pkg.code)
    setSupportedFieldIds(pkg.supportedFields ?? [])
    setInstalledBaseline(fingerprintPluginPackage(pkg))
    setSelectedPluginName(pkg.name)
    setLoadedInstalledName(pkg.name)
    setDryRun(null)
    setDryRunPackageFingerprint(null)
    setVerification(null)
    resetAgentUi()
    setFeedbackText('')
  }

  const resetToNewPlugin = (nextKind: PluginKind): void => {
    setKind(nextKind)
    setSiteName('')
    setSiteUrl('')
    setTestTarget('')
    setDescription('')
    setVersion('1.0.0')
    setAuthor('Plugin Dev Agent')
    setSupportedFieldIds([])
    setCode('')
    setSelectedPluginName('')
    setLoadedInstalledName(null)
    setInstalledBaseline(null)
    setDryRun(null)
    setDryRunPackageFingerprint(null)
    setVerification(null)
    resetAgentUi()
    setFeedbackText('')
  }

  const refreshUserPlugins = async (pluginKind: PluginKind): Promise<void> => {
    setPluginsLoading(true)
    try {
      const details =
        pluginKind === 'video'
          ? await api.scrape.listPluginDetails()
          : await api.actressScrape.listPluginDetails()
      setUserPluginNames(
        details
          .filter((plugin) => plugin.source === 'user' || plugin.source === 'builtin')
          .map((plugin) => plugin.name)
          .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      )
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      setUserPluginNames([])
    } finally {
      setPluginsLoading(false)
    }
  }

  useEffect(() => {
    void refreshUserPlugins(kind)
  }, [kind])

  const loadInstalledPlugin = async (name: string): Promise<void> => {
    if (pluginsLoading || busy !== null) return
    setPluginsLoading(true)
    try {
      const pkg =
        kind === 'video'
          ? await api.scrape.getPluginPackage(name)
          : await api.actressScrape.getPluginPackage(name)
      applyLoadedPackage(pkg)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginsLoading(false)
    }
  }

  const buildPackage = (): ScraperPluginPackage => ({
    schemaVersion: 1,
    kind,
    name: siteName.trim() || derivePluginNameFromUrl(siteUrl, kind),
    version: version.trim() || '1.0.0',
    description: description.trim(),
    author: author.trim() || undefined,
    homepage: siteUrl.trim() || undefined,
    supportedFields: supportedFieldIds.length > 0 ? (supportedFieldIds as Array<VideoScrapeField | ActressScrapeField>) : allFields,
    code
  })

  const hasUninstalledChanges = useMemo(() => {
    if (!hasPackage) return false
    const current = fingerprintPluginPackage(buildPackage())
    if (installedBaseline) return current !== installedBaseline
    return true
  }, [
    hasPackage,
    installedBaseline,
    kind,
    siteName,
    siteUrl,
    testTarget,
    description,
    version,
    author,
    supportedFieldIds,
    code
  ])

  const currentPackageFingerprint = hasPackage ? fingerprintPluginPackage(buildPackage()) : null
  const resultStale =
    Boolean(dryRun && dryRunPackageFingerprint && currentPackageFingerprint) &&
    dryRunPackageFingerprint !== currentPackageFingerprint
  const installState: 'not-installed' | 'dirty' | 'synced' = installedBaseline
    ? hasUninstalledChanges
      ? 'dirty'
      : 'synced'
    : hasPackage
      ? 'not-installed'
      : 'not-installed'
  const resultCount = dryRun?.cases?.length ?? (dryRun ? 1 : 0)

  useEffect(() => {
    packageFingerprintRef.current = currentPackageFingerprint
  }, [currentPackageFingerprint])

  const needsLeaveConfirm = hasUninstalledChanges || activeAgent
  const leaveConfirmMessage = activeAgent
    ? hasUninstalledChanges
      ? 'Agent 仍在运行或等待操作，离开会终止当前会话；插件也有未安装更改。'
      : 'Agent 仍在运行或等待操作，离开会终止当前会话。'
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
    onLoadConsumed()
  }, [loadPackage])

  const runGuardedAction = (action: () => void): void => {
    if (hasUninstalledChanges) {
      leaveGuard.requestLeave(action)
      return
    }
    action()
  }

  const handleSelectPlugin = (name: string): void => {
    if (name === selectedPluginName) return
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

  const buildAgentInput = () => {
    const pkg = buildPackage()
    const targets = resolvedTestTargets
    return {
      kind: pkg.kind,
      siteName: pkg.name,
      siteUrl: pkg.homepage,
      description: pkg.description || undefined,
      supportedFields: pkg.supportedFields ?? allFields,
      testTargets: targets.length > 0 ? targets : undefined
    }
  }

  const applyGeneratedPackage = (pkg: ScraperPluginPackage): void => {
    setKind(pkg.kind)
    setSiteName(pkg.name)
    setVersion(pkg.version ?? '1.0.0')
    setDescription(pkg.description ?? '')
    setAuthor(pkg.author ?? 'Plugin Dev Agent')
    setSiteUrl(pkg.homepage ?? siteUrl)
    setSupportedFieldIds(pkg.supportedFields ?? [])
    setCode(pkg.code)
  }

  const saveAgentSettings = async (): Promise<void> => {
    if (busy) return
    setBusy('save-key')
    try {
      const next = await api.settings.update({
        pluginDevAgentMaxSteps: maxAgentSteps,
        pluginDevAgentMaxContextTokens: maxContextTokens
      })
      setSettings(next)
      setShowConnectionModal(false)
      toast.show('Agent 配置已保存', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusy(null)
    }
  }

  const openConnectionModal = (): void => {
    setMaxAgentSteps(settings.pluginDevAgentMaxSteps)
    setMaxContextTokens(settings.pluginDevAgentMaxContextTokens)
    setShowConnectionModal(true)
  }

  const canCancelAgent = busy === 'agent' && agentSessionId !== null

  const agentEndToast = (status: PluginDevSessionStatus): { message: string; kind: 'success' | 'error' | 'info' } => {
    if (status === 'completed') return { message: 'Agent 开发完成', kind: 'success' }
    if (status === 'cancelled') return { message: 'Agent 已终止', kind: 'info' }
    return { message: 'Agent 已结束', kind: 'error' }
  }

  const cancelAgent = (): void => {
    const sessionId = agentSessionIdRef.current
    if (!sessionId) return
    if (busy !== 'agent' && !isAgentRunningRef.current) return
    void api.pluginDev.cancel(sessionId)
    isAgentRunningRef.current = false
    setAgentStatus('cancelled')
    setActiveTool(null)
  }

  const startAgent = async (mode: 'create' | 'debug' | 'feedback', userMessage?: string): Promise<boolean> => {
    if (busy || !canUseAgent) return false
    if (mode !== 'create' && resolvedTestTargets.length === 0) {
      toast.show(kindProfile.aiDebugNeedsTargetMessage, 'error')
      return false
    }
    const priorDryRun = dryRun
    isAgentRunningRef.current = true
    agentSessionIdRef.current = null
    setBusy('agent')
    resetAgentUi()
    setAgentTab('conversation')
    if (userMessage?.trim()) {
      setConversationItems([{ id: nextConversationId('user'), type: 'user', text: userMessage.trim() }])
    }
    setAgentStatus('running')
    try {
      const result = await api.pluginDev.start({
        ...buildAgentInput(),
        mode,
        userMessage: userMessage?.trim(),
        package: mode === 'create' && !code.trim() ? undefined : buildPackage(),
        lastDryRun: priorDryRun ?? undefined
      })
      setAgentSessionId(result.sessionId)
      setAgentStatus(result.status)
      applyGeneratedPackage(result.package)
      if (result.dryRun) {
        setDryRun(result.dryRun)
        setDryRunPackageFingerprint(fingerprintPluginPackage(result.package))
        if (shouldOpenResultAfterAgentDone(result.status, result.dryRun)) {
          setAgentTab('result')
        }
      } else if (priorDryRun) {
        setDryRun(priorDryRun)
      }
      setVerification(result.verification ?? null)
      if (result.status === 'waiting_user') {
        setWaitingUserReason('需要用户操作后继续')
        setAgentTab('conversation')
      }
      setConversationItems((prev) => [
        ...prev,
        { id: nextConversationId('agent'), type: 'agent', text: result.summary }
      ])
      const toastInfo = agentEndToast(result.status)
      toast.show(toastInfo.message, toastInfo.kind)
      return true
    } catch (e) {
      setAgentStatus('failed')
      toast.show(String((e as Error).message), 'error')
      return false
    } finally {
      isAgentRunningRef.current = false
      setActiveTool(null)
      setBusy(null)
    }
  }

  const continueAgent = async (text: string): Promise<boolean> => {
    if (busy || !agentSessionId) return false
    isAgentRunningRef.current = true
    setBusy('agent')
    setConversationItems((prev) => [...prev, { id: nextConversationId('user'), type: 'user', text }])
    setAgentStatus('running')
    setAgentTab('conversation')
    setWaitingUserReason(null)
    try {
      const result = await api.pluginDev.message({
        sessionId: agentSessionId,
        text,
        lastDryRun: dryRun ?? undefined
      })
      setAgentStatus(result.status)
      applyGeneratedPackage(result.package)
      if (result.dryRun) {
        setDryRun(result.dryRun)
        setDryRunPackageFingerprint(fingerprintPluginPackage(result.package))
        if (shouldOpenResultAfterAgentDone(result.status, result.dryRun)) {
          setAgentTab('result')
        }
      }
      setVerification(result.verification ?? null)
      setConversationItems((prev) => [
        ...prev,
        { id: nextConversationId('agent'), type: 'agent', text: result.summary }
      ])
      const toastInfo =
        result.status === 'completed'
          ? { message: 'Agent 继续完成', kind: 'success' as const }
          : agentEndToast(result.status)
      toast.show(toastInfo.message, toastInfo.kind)
      return true
    } catch (e) {
      setAgentStatus('failed')
      toast.show(String((e as Error).message), 'error')
      return false
    } finally {
      isAgentRunningRef.current = false
      setActiveTool(null)
      setBusy(null)
    }
  }

  const sendAgentFeedback = async (): Promise<void> => {
    const feedback = feedbackText.trim()
    if (busy || !canUseAgent || !hasPackage || !feedback) return
    if (!canResumeAgent && resolvedTestTargets.length === 0) {
      toast.show(kindProfile.aiDebugNeedsTargetMessage, 'error')
      return
    }
    if (canResumeAgent) {
      if (await continueAgent(feedback)) setFeedbackText('')
      return
    }
    if (await startAgent(loadedInstalledName ? 'debug' : 'feedback', feedback)) {
      setFeedbackText('')
    }
  }

  const continueAfterChallenge = async (): Promise<void> => {
    await continueAgent('用户已完成浏览器验证，请继续探测页面并修复插件。')
  }

  const runPrimaryAgentAction = async (): Promise<void> => {
    if (feedbackPending && canSendAgentFeedback) {
      await sendAgentFeedback()
      return
    }
    if (canResumeAgent) {
      await continueAgent('请继续当前插件开发/调试任务。')
      return
    }
    await startAgent(hasPackage ? (loadedInstalledName ? 'debug' : 'feedback') : 'create')
  }

  const install = async (): Promise<void> => {
    if (busy || !hasPackage || !hasUninstalledChanges) return
    setBusy('install')
    try {
      const descriptor = await api.pluginDev.install({ package: buildPackage(), overwriteUser: true })
      await onInstalled(kind)
      setLoadedInstalledName(descriptor.name)
      setSelectedPluginName(descriptor.name)
      setInstalledBaseline(fingerprintPluginPackage(buildPackage()))
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

  const statusClass =
    agentStatus === 'running'
      ? 'is-running'
      : agentStatus === 'waiting_user'
        ? 'is-waiting'
        : agentStatus === 'completed'
          ? 'is-ok'
        : agentStatus === 'failed'
          ? 'is-fail'
          : agentStatus === 'cancelled'
            ? 'is-cancelled'
            : ''

  return (
    <div className="plugin-dev-shell">
      <nav className="plugin-dev-breadcrumb" aria-label="当前位置">
        <button
          type="button"
          className="settings-back-link"
          onClick={() => leaveGuard.requestLeave(() => navigate('/settings'))}
        >
          设置
        </button>
        <span>/</span>
        <button
          type="button"
          className="settings-back-link"
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

      <header className="plugin-dev-toolbar">
        <div className="plugin-dev-toolbar-start">
          <div
            className="settings-tab-bar settings-tab-bar--compact plugin-dev-kind-toggle plugin-dev-toolbar-kind-toggle"
            role="group"
            aria-label="插件类型"
          >
            <button
              type="button"
              className={`settings-tab-button${kind === 'video' ? ' is-active' : ''}`}
              disabled={busy !== null}
              onClick={() => changeKind('video')}
            >
              影片
            </button>
            <button
              type="button"
              className={`settings-tab-button${kind === 'actress' ? ' is-active' : ''}`}
              disabled={busy !== null}
              onClick={() => changeKind('actress')}
            >
              演员
            </button>
          </div>
          <span className={`plugin-dev-status-pill ${statusClass}`}>
            {agentStatusLabel(agentStatus, agentStep)}
          </span>
        </div>
        <div className="plugin-dev-toolbar-actions">
          <span className="plugin-source-badge plugin-source-badge--user plugin-dev-source-badge">
            {activeLlmModelLabel || '未配置模型'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={openConnectionModal}
          >
            连接设置
          </button>
          {code.trim().length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => setShowCodeModal(true)}
            >
              查看代码
            </button>
          )}
        </div>
      </header>

      <div className="plugin-dev-main plugin-dev-main--agent-focus">
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
          userPluginNames={userPluginNames}
          pluginsLoading={pluginsLoading}
          busy={busy !== null}
          canUseAgent={canResumeAgent ? canUseAgent : canStartAgent}
          hasPackage={hasPackage}
          canResumeAgent={canResumeAgent}
          agentCompleted={agentStatus === 'completed'}
          feedbackPending={feedbackPending}
          agentDisabledReason={agentDisabledReason}
          agentPrimaryDisabledReason={agentPrimaryDisabledReason}
          activeLlmReady={llmReady}
          agentBusy={busy === 'agent'}
          installBusy={busy === 'install'}
          canInstall={hasUninstalledChanges}
          onSelectPlugin={handleSelectPlugin}
          onStartAgent={() => void runPrimaryAgentAction()}
          onInstall={() => void install()}
          onSiteNameChange={setSiteName}
          onSiteUrlChange={setSiteUrl}
          onTestTargetChange={setTestTarget}
          onDescriptionChange={setDescription}
          onVersionChange={setVersion}
          onAuthorChange={setAuthor}
          onSupportedFieldsChange={setSupportedFieldIds}
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
          verification={verification}
          resultStale={resultStale}
          installState={installState}
          waitingUserReason={waitingUserReason}
          feedbackText={feedbackText}
          busy={busy !== null}
          canSend={canSendAgentFeedback}
          canCancelAgent={canCancelAgent}
          onTabChange={setAgentTab}
          onFeedbackChange={setFeedbackText}
          onSend={() => void sendAgentFeedback()}
          onCancelAgent={cancelAgent}
          onContinueChallenge={() => void continueAfterChallenge()}
        />
      </div>

      {showConnectionModal && (
        <PluginDevConnectionModal
          providerLabel={activeLlmProvider?.name ?? '未配置'}
          modelLabel={activeLlmModelLabel}
          maxSteps={maxAgentSteps}
          maxContextTokens={maxContextTokens}
          busy={busy === 'save-key'}
          onMaxStepsChange={setMaxAgentSteps}
          onMaxContextTokensChange={setMaxContextTokens}
          onOpenModelSettings={() => {
            setShowConnectionModal(false)
            leaveGuard.requestLeave(() => navigate('/settings/models/providers'))
          }}
          onSave={() => void saveAgentSettings()}
          onClose={() => setShowConnectionModal(false)}
        />
      )}

      {showCodeModal && (
        <PluginDevCodeModal
          kind={kind}
          code={code}
          pluginName={siteName.trim()}
          onClose={() => setShowCodeModal(false)}
        />
      )}
    </div>
  )
}
