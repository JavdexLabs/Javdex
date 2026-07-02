import {
  type PluginDevPageInsight,
  type PluginDevDryRunCase,
  type PluginDevDryRunResult,
  resolveScrapeProxyUrl
} from '@shared/types'
import { scrapeBrowser } from '../../scrapers/scrapeBrowser'
import { getSettings } from '../../settings/settingsStore'
import {
  dryRunPluginPackage,
  installDevPluginPackage,
  normalizePackageForDev,
  replacePluginFunctionCode,
  replacePluginSnippetCode,
  listTopLevelFunctions
} from '../pluginDevService'
import { assertNoDuplicateTopLevelBindings } from '../pluginDevCodeEdit'
import {
  describeFieldsForKind,
  getPluginDevKindProfile,
  normalizeTestTargets,
  resolveDryRunTargetsFromArgs,
  userRequestedSupportedFieldRemoval
} from '@shared/pluginDevKindProfile'
import {
  appendCheerioDryRunHint,
  formatPackageCodeForAgent,
  hasSubstantialPluginCode,
  incrementalEditPolicyText
} from './pluginDevCodePolicy'
import { formatPageInsightForPrompt } from '../pluginDevPageFormat'
import {
  collectSiteUnsupportedSupportedFields,
  isBlockingVerificationFailure,
  verifyDebugResultAgainstPages,
  syncSupportedFieldsFromVerification
} from '../pluginDevVerification'
import { getSession, hashCode, invalidateVerification, isDryRunStaleForVerify, withBrowserLock } from './sessionStore'
import { summarizeDryRunForAgent } from './prompts'
import type { PluginDevAgentEvent, ToolExecutionResult } from './types'

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function toolError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): ToolExecutionResult {
  return {
    ok: false,
    content: JSON.stringify({ code, message, ...extra }, null, 2)
  }
}

function describeFields(kind: import('@shared/types').ScraperPluginKind, fields: string[]): string {
  return describeFieldsForKind(
    kind,
    fields as import('@shared/types').VideoScrapeField[] | import('@shared/types').ActressScrapeField[]
  )
}

function normalizeInsight(label: string, value: unknown): PluginDevPageInsight {
  const input = value && typeof value === 'object' ? (value as Partial<PluginDevPageInsight>) : {}
  return {
    label,
    url: typeof input.url === 'string' ? input.url : '',
    title: typeof input.title === 'string' ? input.title : '',
    text: typeof input.text === 'string' ? input.text : '',
    forms: Array.isArray(input.forms) ? input.forms.slice(0, 12) : [],
    links: Array.isArray(input.links)
      ? input.links.slice(0, 80).map((link) => ({
          text: typeof link.text === 'string' ? link.text : '',
          href: typeof link.href === 'string' ? link.href : '',
          region:
            link.region === 'breadcrumb' || link.region === 'metadata' || link.region === 'other'
              ? link.region
              : undefined,
          parentSelector:
            typeof link.parentSelector === 'string' ? link.parentSelector : undefined
        }))
      : [],
    domRegions: Array.isArray(input.domRegions) ? input.domRegions : undefined,
    definitionLists: Array.isArray(input.definitionLists) ? input.definitionLists : undefined
  }
}

function buildDiscoveryFromSession(session: NonNullable<ReturnType<typeof getSession>>) {
  if (!session.lastInspectPage) return undefined
  return { pages: [session.lastInspectPage], notes: session.pageNotes.map((n) => n.text) }
}

async function refreshVerificationPageFromBrowser(
  session: NonNullable<ReturnType<typeof getSession>>,
  label = '浏览器当前页'
): Promise<PluginDevPageInsight | undefined> {
  try {
    const status = (await scrapeBrowser.performAction('status', {})) as {
      isChallenge?: boolean
      url?: string
    }
    if (status.isChallenge) return undefined
    if (!status.url || status.url === 'about:blank') return undefined
    const raw = await scrapeBrowser.performAction('inspect', {
      maxTextLength: 6000,
      maxLinks: 100
    })
    const page = normalizeInsight(label, raw)
    if (page.url || page.title || page.text) {
      session.lastInspectPage = page
      return page
    }
  } catch {
    // Browser may not be open yet; in that case verification falls back to the last explicit inspect.
  }
  return undefined
}

function summarizeDryRun(session: NonNullable<ReturnType<typeof getSession>>): string {
  const r = session.lastDryRun
  if (!r) return '尚未 dry-run'
  if (r.cases?.length) {
    const okCount = r.cases.filter((item) => item.ok).length
    return `多目标 ${okCount}/${r.cases.length} 成功：${r.cases
      .map((item) => `${item.target}=${item.ok ? 'ok' : item.error || 'failed'}`)
      .join(' ')}`
  }
  if (!r.ok) return `失败：${r.error || '未知'}`
  if (!r.result || typeof r.result !== 'object') return '成功但无结果'
  return getPluginDevKindProfile(session.kind).summarizeDryRunResult(
    r.result as Record<string, unknown>
  )
}

function compactDryRunForTool(session: NonNullable<ReturnType<typeof getSession>>): string {
  return summarizeDryRunForAgent(session.lastDryRun)
}

async function dryRunFailurePageHint(
  session: NonNullable<ReturnType<typeof getSession>>
): Promise<string> {
  if (session.lastDryRun?.ok) return ''
  const page = await refreshVerificationPageFromBrowser(session, 'dry-run 当前页')
  if (!page) return ''
  return `\n\ndry-run 后验证窗口当前页：\n${formatPageInsightForPrompt(page, {
    textLimit: 1200,
    linkLimit: 12
  })}`
}

function dryRunTargets(
  session: NonNullable<ReturnType<typeof getSession>>,
  args: Record<string, unknown>
): string[] {
  return resolveDryRunTargetsFromArgs(session.kind, args, session.testTargets ?? [])
}

function rememberDryRun(
  session: NonNullable<ReturnType<typeof getSession>>,
  dryRun: PluginDevDryRunResult
): void {
  const fingerprint = JSON.stringify(dryRun.cases ?? dryRun.result ?? null)
  const prevFingerprint = JSON.stringify(session.lastDryRun?.cases ?? session.lastDryRun?.result ?? null)
  if (session.lastDryRun && prevFingerprint === fingerprint) {
    session.duplicateDryRunCount += 1
  } else {
    session.duplicateDryRunCount = 0
  }
  session.lastDryRun = dryRun
  session.lastDryRunCodeHash = hashCode(session.package.code)
  invalidateVerification(session)
}

function sourceUrlFromDryRun(dryRun: PluginDevDryRunResult): string | undefined {
  const result = dryRun.result
  if (!result || typeof result !== 'object') return undefined
  const sourceUrl = (result as { sourceUrl?: unknown }).sourceUrl
  return typeof sourceUrl === 'string' && sourceUrl.trim() ? sourceUrl.trim() : undefined
}

async function refreshVerificationPageForDryRun(
  session: NonNullable<ReturnType<typeof getSession>>,
  dryRun: PluginDevDryRunResult,
  label: string
): Promise<PluginDevPageInsight | undefined> {
  const sourceUrl = sourceUrlFromDryRun(dryRun)
  if (sourceUrl) {
    try {
      const settings = getSettings()
      await scrapeBrowser.setProxy(resolveScrapeProxyUrl(settings))
      await scrapeBrowser.fetchPage(sourceUrl, {
        readySelector: 'body',
        timeoutMs: 45000
      })
    } catch {
      // Fall back to whatever page the validation browser can currently inspect.
    }
  }
  return refreshVerificationPageFromBrowser(session, label)
}

function dryRunFromCase(item: PluginDevDryRunCase): PluginDevDryRunResult {
  return {
    ok: item.ok,
    result: item.result,
    logs: item.logs,
    error: item.error
  }
}

function supportedFieldsPolicyForTool(session: NonNullable<ReturnType<typeof getSession>>): string {
  const profile = getPluginDevKindProfile(session.kind)
  if (session.mode !== 'create') {
    return [
      '调试已安装插件：plugin_verify 后只会自动新增 supportedFields，不会自动删除。',
      '删除支持字段须用户明确要求（如「从支持字段移除 summary」），再调用 plugin_update_package。',
      '测试目标缺字段时保持留空并修复解析逻辑，不要因单页缺失删除字段。'
    ].join(' ')
  }
  return [
    '首次开发（create）：plugin_verify 后会自动新增站点已支持但遗漏的字段，并移除站点不支持的字段。',
    '站点不提供某字段时 verify 备注须含「站点无此字段」或「站点详情页模板无此字段标签」。',
    '仅当前测试页面缺字段（如本片无系列）时不要删除 supportedFields，verify 备注用「页面无此字段」。',
    profile.supportedFieldsMissingExample
  ].join(' ')
}

function dryRunResultsForSync(session: NonNullable<ReturnType<typeof getSession>>): unknown[] {
  if (session.lastDryRun?.cases?.length) {
    return session.lastDryRun.cases.map((item) => item.result)
  }
  return session.lastDryRun?.result !== undefined ? [session.lastDryRun.result] : []
}

function syncSupportedFieldsAfterVerification(
  session: NonNullable<ReturnType<typeof getSession>>,
  step: number,
  verificationItems: Array<{ field: string; status: string; note: string }>
): PluginDevAgentEvent[] {
  const active = session.package.supportedFields ?? session.supportedFields
  const sync = syncSupportedFieldsFromVerification({
    mode: session.mode,
    kind: session.kind,
    supportedFields: active,
    verificationItems: verificationItems as import('@shared/types').PluginDevFieldVerification[],
    lastResults: dryRunResultsForSync(session)
  })
  if (!sync.changed) return []

  session.package = normalizePackageForDev({
    ...session.package,
    supportedFields: sync.supportedFields
  })
  session.supportedFields = [...sync.supportedFields]
  return [
    {
      type: 'package_updated',
      sessionId: session.id,
      step,
      package: session.package
    }
  ]
}

function userRequestedWholeRewrite(instruction: string | undefined): boolean {
  return /重写|重新实现|整包|推倒|从头写|整体重构/.test(instruction ?? '')
}

function canUseWholeRewrite(
  session: NonNullable<ReturnType<typeof getSession>>,
  args: Record<string, unknown>,
  hadSubstantialCode: boolean
): boolean {
  if (!hadSubstantialCode) return true
  if (userRequestedWholeRewrite(session.lastUserInstruction)) return true
  return args.forceWholeRewrite === true && typeof args.forceReason === 'string' && args.forceReason.trim().length >= 6
}

function canInstallFromAgent(session: NonNullable<ReturnType<typeof getSession>>): boolean {
  if (!session.lastDryRun?.ok) return false
  const report = session.lastVerification
  if (!report) return false
  return report.items.filter((item) => isBlockingVerificationFailure(item)).length === 0
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((item) => set.has(item))
}

function canPreserveVerificationForSupportedFieldsPatch(
  session: NonNullable<ReturnType<typeof getSession>>,
  args: Record<string, unknown>,
  current: readonly string[],
  next: readonly string[]
): boolean {
  const keys = Object.keys(args).filter((key) => key !== 'confirmUserRemoval')
  if (keys.length !== 1 || keys[0] !== 'supportedFields') return false
  if (!session.lastDryRun?.ok || !session.lastVerification) return false
  if (isDryRunStaleForVerify(session)) return false
  if (session.lastVerification.items.some((item) => isBlockingVerificationFailure(item))) return false

  const added = next.filter((field) => !current.includes(field))
  if (added.length > 0) return false

  const removed = current.filter((field) => !next.includes(field))
  if (removed.length === 0) return sameStringSet(current, next)

  if (args.confirmUserRemoval === true || userRequestedSupportedFieldRemoval(session.lastUserInstruction)) {
    return true
  }

  const removable = new Set(
    collectSiteUnsupportedSupportedFields(
      session.kind,
      current as import('@shared/types').VideoScrapeField[] | import('@shared/types').ActressScrapeField[],
      session.lastVerification.items
    )
  )
  return removed.every((field) => removable.has(field as never))
}

function selectCodeForState(code: string, args: Record<string, unknown>): string {
  const includeCode = args.includeCode === true
  if (!includeCode) return ''
  const startLine = typeof args.codeStartLine === 'number' ? Math.max(1, Math.floor(args.codeStartLine)) : 1
  const lineCount =
    typeof args.codeLineCount === 'number'
      ? Math.max(1, Math.min(260, Math.floor(args.codeLineCount)))
      : undefined
  if (startLine === 1 && lineCount === undefined) return formatPackageCodeForAgent(code)
  const lines = code.split(/\r?\n/)
  const startIndex = startLine - 1
  const selected = lines.slice(startIndex, lineCount ? startIndex + lineCount : undefined).join('\n')
  return formatPackageCodeForAgent(selected)
}

function parserNameForKind(kind: import('@shared/types').ScraperPluginKind): string {
  return kind === 'video' ? 'parseVideo' : 'parseActress'
}

export async function executeTool(
  sessionId: string,
  toolName: string,
  rawArgs: string,
  step: number
): Promise<ToolExecutionResult> {
  const session = getSession(sessionId)
  if (!session) {
    return toolError('SESSION_NOT_FOUND', '会话不存在')
  }

  const args = parseToolArgs(rawArgs)
  const events: PluginDevAgentEvent[] = []

  try {
    switch (toolName) {
      case 'plugin_get_state': {
        const activeSupportedFields = session.package.supportedFields ?? session.supportedFields
        const code = selectCodeForState(session.package.code, args)
        const content = JSON.stringify(
          {
            kind: session.kind,
            mode: session.mode,
            siteName: session.siteName,
            siteUrl: session.siteUrl,
            testTarget: session.testTargets?.[0],
            testTargets: session.testTargets ?? [],
            supportedFields: describeFields(session.kind, activeSupportedFields),
            supportedFieldsPolicy: supportedFieldsPolicyForTool(session),
            package: {
              name: session.package.name,
              version: session.package.version,
              supportedFields: activeSupportedFields,
              codeLength: session.package.code.length,
              topLevelFunctions: listTopLevelFunctions(session.package.code),
              ...(code ? { code } : {}),
              codeOmitted:
                !code
                  ? '默认省略完整 code 以节省上下文；需要读取时请传 includeCode=true，可配合 codeStartLine/codeLineCount。'
                  : undefined,
              incrementalEditOnly: session.incrementalEditOnly || hasSubstantialPluginCode(session.kind, session.package.code)
            },
            incrementalEditPolicy:
              session.incrementalEditOnly || hasSubstantialPluginCode(session.kind, session.package.code)
                ? incrementalEditPolicyText()
                : undefined,
            lastDryRunSummary: session.lastDryRun ? JSON.parse(compactDryRunForTool(session)) : null,
            dryRunStaleForVerify: isDryRunStaleForVerify(session),
            lastVerification: session.lastVerification,
            pageNotes: session.pageNotes.map((n) => n.text)
          },
          null,
          2
        )
        return { ok: true, content }
      }

      case 'plugin_update_code': {
        const rawMode = typeof args.mode === 'string' ? args.mode : ''
        if (
          rawMode !== 'replace_snippet' &&
          rawMode !== 'replace_function' &&
          rawMode !== 'replace_all'
        ) {
          return {
            ...toolError(
              'INVALID_UPDATE_MODE',
              'mode 必须是 replace_snippet、replace_function 或 replace_all；未知 mode 不会自动按 replace_all 执行。'
            )
          }
        }
        const mode = rawMode
        const hadSubstantialCode = hasSubstantialPluginCode(session.kind, session.package.code)
        if (mode === 'replace_all' && !canUseWholeRewrite(session, args, hadSubstantialCode)) {
          return toolError(
            'INCREMENTAL_EDIT_REQUIRED',
            '当前已有实质插件 code，默认禁止整包 replace_all。请优先使用 replace_snippet 或 replace_function 做最小修改。',
            {
              topLevelFunctions: listTopLevelFunctions(session.package.code),
              escapeHatch:
                '确需整体重构时，需用户明确要求重写，或传 forceWholeRewrite=true 并提供 forceReason 说明原因。'
            }
          )
        }
        let nextCode: string

        if (mode === 'replace_snippet') {
          const oldText = typeof args.oldText === 'string' ? args.oldText : ''
          const newText = typeof args.newText === 'string' ? args.newText : ''
          const nearLine = typeof args.nearLine === 'number' ? args.nearLine : undefined
          if (!oldText) return { ok: false, content: 'replace_snippet 时 oldText 不能为空' }
          nextCode = replacePluginSnippetCode(
            session.package.kind,
            session.package.code,
            oldText,
            newText,
            nearLine
          )
        } else {
          const code = typeof args.code === 'string' ? args.code : ''
          if (!code.trim()) return { ok: false, content: 'code 不能为空' }
          const functionName =
            typeof args.functionName === 'string' ? args.functionName.trim() : undefined
          if (mode === 'replace_function') {
            const target = functionName || parserNameForKind(session.kind)
            const functions = listTopLevelFunctions(session.package.code)
            if (hadSubstantialCode && !functions.some((item) => item.name === target)) {
              return toolError(
                'FUNCTION_NOT_FOUND',
                `当前已有实质 code，未找到顶层函数 ${target}，不会通过 append 新函数来伪装替换。`,
                { topLevelFunctions: functions }
              )
            }
            nextCode = replacePluginFunctionCode(
              session.package.kind,
              session.package.code,
              functionName,
              code
            )
          } else {
            nextCode = code
          }
        }

        const nextPackage = normalizePackageForDev({
          ...session.package,
          code: nextCode
        })
        if (mode === 'replace_all') {
          assertNoDuplicateTopLevelBindings(nextPackage.code)
        }
        const prevHash = hashCode(session.package.code)
        session.package = nextPackage
        if (hasSubstantialPluginCode(session.kind, session.package.code)) {
          session.incrementalEditOnly = true
        }
        const same = hashCode(session.package.code) === prevHash
        if (!same) {
          invalidateVerification(session)
        }
        events.push({
          type: 'package_updated',
          sessionId,
          step,
          package: session.package
        })
        const replaceAllHint =
          mode === 'replace_all' && hadSubstantialCode
            ? '（已按显式重写理由执行整包替换）'
            : ''
        const modeHint =
          mode === 'replace_snippet'
            ? `（replace_snippet：${typeof args.oldText === 'string' ? args.oldText.length : 0}→${typeof args.newText === 'string' ? args.newText.length : 0} 字符）`
            : ''
        return {
          ok: true,
          content: same
            ? '警告：code 与更新前完全相同'
            : `已更新 code（${session.package.code.length} 字符）${modeHint}${replaceAllHint}`,
          events
        }
      }

      case 'plugin_update_package': {
        const currentSupportedFields = session.package.supportedFields ?? session.supportedFields
        const nextSupportedFields = Array.isArray(args.supportedFields)
          ? (args.supportedFields as typeof currentSupportedFields)
          : currentSupportedFields
        const preserveVerification = Array.isArray(args.supportedFields)
          ? canPreserveVerificationForSupportedFieldsPatch(
              session,
              args,
              currentSupportedFields,
              nextSupportedFields
            )
          : false
        if (Array.isArray(args.supportedFields)) {
          const current = currentSupportedFields
          const next = nextSupportedFields
          const removed = current.filter((field) => !next.includes(field))
          if (session.mode !== 'create' && removed.length > 0) {
            const userRequested =
              args.confirmUserRemoval === true ||
              userRequestedSupportedFieldRemoval(session.lastUserInstruction)
            if (!userRequested) {
              return {
                ok: false,
                content:
                  'DEBUG_SUPPORTED_FIELDS_REMOVE_LOCKED: 调试模式仅允许新增支持字段；删除须用户明确要求后再调用 plugin_update_package（可传 confirmUserRemoval: true）。'
              }
            }
          }
        }
        const patch: Record<string, unknown> = { ...session.package }
        if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim()
        if (typeof args.version === 'string') patch.version = args.version
        if (typeof args.description === 'string') patch.description = args.description
        if (typeof args.author === 'string') patch.author = args.author
        if (typeof args.homepage === 'string') patch.homepage = args.homepage
        if (Array.isArray(args.supportedFields)) patch.supportedFields = args.supportedFields
        session.package = normalizePackageForDev(patch)
        if (Array.isArray(args.supportedFields)) {
          session.supportedFields = [...(session.package.supportedFields ?? session.supportedFields)]
        }
        if (!preserveVerification) {
          invalidateVerification(session)
        }
        events.push({
          type: 'package_updated',
          sessionId,
          step,
          package: session.package
        })
        return {
          ok: true,
          content: preserveVerification
            ? '插件元数据已更新；本次仅调整 supportedFields，且上次语义验证仍有效，无需重复 plugin_verify。'
            : '插件元数据已更新',
          events
        }
      }

      case 'plugin_dry_run': {
        const profile = getPluginDevKindProfile(session.kind)
        const targets = dryRunTargets(session, args)
        if (targets.length === 0) {
          return { ok: false, content: profile.dryRunMissingMessage }
        }

        const cases: PluginDevDryRunCase[] = []
        let dryRun: PluginDevDryRunResult | undefined
        for (const target of targets) {
          session.testTargets = [...new Set([...(session.testTargets ?? []), target])]
          dryRun = await dryRunPluginPackage({
            package: session.package,
            testTarget: target,
            testTargets: [target]
          })
          cases.push({
            target,
            ok: dryRun.ok,
            error: dryRun.error,
            result: dryRun.result,
            logs: dryRun.logs
          })
        }

        if (!dryRun) return { ok: false, content: 'dry-run 未执行' }
        const allOk = cases.every((item) => item.ok)
        const aggregateDryRun: PluginDevDryRunResult =
          cases.length > 1
            ? {
                ok: allOk,
                result: dryRun.result,
                logs: cases.flatMap((item) =>
                  item.logs.length
                    ? item.logs.map((line) => `[${item.target}] ${line}`)
                    : [`[${item.target}] ${item.ok ? 'dry-run ok' : item.error || 'dry-run failed'}`]
                ),
                error: allOk
                  ? undefined
                  : `多目标 dry-run 有 ${cases.filter((item) => !item.ok).length}/${cases.length} 个失败`,
                cases
              }
            : dryRun
        rememberDryRun(session, aggregateDryRun)
        events.push({
          type: 'dry_run_updated',
          sessionId,
          step,
          dryRun: aggregateDryRun
        })
        const pageHint = allOk ? '' : await dryRunFailurePageHint(session)
        const batchContent =
          cases.length > 1
            ? `${JSON.stringify(
                {
                  ok: allOk,
                  cases: cases.map((item) => ({
            ...item,
            error: appendCheerioDryRunHint(item.error)
          })),
                  note: getPluginDevKindProfile(session.kind).multiDryRunNote
                },
                null,
                2
              )}${pageHint}`
            : `${compactDryRunForTool(session)}${pageHint}`
        return {
          ok: allOk,
          content: batchContent,
          structured: { summary: summarizeDryRun(session) },
          events
        }
      }

      case 'plugin_verify': {
        if (!session.lastDryRun?.result) {
          return toolError('NO_DRY_RUN', '尚未 dry-run，请先调用 plugin_dry_run 获取调试结果后再 verify。')
        }
        if (isDryRunStaleForVerify(session)) {
          return toolError(
            'STALE_DRY_RUN',
            '插件 code 已变更但尚未重新 dry-run。请先调用 plugin_dry_run，再 plugin_verify。',
            { hint: '若仅修改了 supportedFields，无需重新 dry-run，可直接 verify。' }
          )
        }
        if (!session.lastDryRun.ok) {
          return toolError(
            'DRY_RUN_FAILED',
            '最近一次 dry-run 未通过，不能进行语义 verify。请先修复 dry-run 失败并重新运行 plugin_dry_run。',
            {
              error: appendCheerioDryRunHint(session.lastDryRun.error),
              cases: session.lastDryRun.cases?.map((item) => ({
                target: item.target,
                ok: item.ok,
                error: appendCheerioDryRunHint(item.error)
              }))
            }
          )
        }
        const userFeedback =
          typeof args.userFeedback === 'string' ? args.userFeedback : undefined
        if (session.lastDryRun.cases?.length) {
          const reports = []
          for (const item of session.lastDryRun.cases) {
            const caseDryRun = dryRunFromCase(item)
            let page: PluginDevPageInsight | undefined
            await withBrowserLock(sessionId, async () => {
              page = await refreshVerificationPageForDryRun(
                session,
                caseDryRun,
                `验证参考页 ${item.target}`
              )
            })
            const report = await verifyDebugResultAgainstPages({
              kind: session.kind,
              lastResult: item.result,
              discovery: page
                ? { pages: [page], notes: session.pageNotes.map((n) => n.text) }
                : buildDiscoveryFromSession(session),
              supportedFields: session.package.supportedFields ?? session.supportedFields,
              userFeedback,
              mode: session.mode,
              testTarget: item.target,
              testTargets: [item.target]
            })
            reports.push({ target: item.target, report })
          }

          const items = reports.flatMap(({ target, report }) =>
            report.items.map((item) => ({
              ...item,
              field: `${target}.${item.field}`,
              note: `[${target}] ${item.note}`
            }))
          )
          const badCount = items.filter((item) => item.status !== 'ok').length
          const referencePages = reports.map(({ target, report }) => ({
            target,
            url: report.referencePage?.url,
            title: report.referencePage?.title,
            label: report.referencePage?.label
          }))
          const verification = {
            referencePages,
            referencePage: reports.at(-1)?.report.referencePage,
            items,
            summary:
              badCount === 0
                ? `多目标语义验证通过：${reports.length}/${reports.length} 个测试目标通过。`
                : `多目标语义验证发现 ${badCount} 项问题，覆盖 ${reports.length} 个测试目标。`
          }
          session.lastVerification = verification
          events.push({
            type: 'verification_updated',
            sessionId,
            step,
            verification
          })
          events.push(...syncSupportedFieldsAfterVerification(session, step, verification.items))
          return { ok: true, content: JSON.stringify(verification, null, 2), events }
        }
        await withBrowserLock(sessionId, async () => {
          await refreshVerificationPageFromBrowser(session, '验证参考页')
        })
        const verification = await verifyDebugResultAgainstPages({
          kind: session.kind,
          lastResult: session.lastDryRun?.result,
          discovery: buildDiscoveryFromSession(session),
          supportedFields: session.package.supportedFields ?? session.supportedFields,
          userFeedback,
          mode: session.mode,
          testTarget: session.testTargets?.[0],
          testTargets: session.testTargets
        })
        session.lastVerification = verification
        events.push({
          type: 'verification_updated',
          sessionId,
          step,
          verification
        })
        events.push(...syncSupportedFieldsAfterVerification(session, step, verification.items))
        return { ok: true, content: JSON.stringify(verification, null, 2), events }
      }

      case 'plugin_install': {
        if (!canInstallFromAgent(session)) {
          return toolError(
            'INSTALL_BLOCKED',
            'Agent 安装前必须先通过 plugin_dry_run 且 plugin_verify 无阻断失败项。请先修复并验证。'
          )
        }
        const descriptor = await installDevPluginPackage({
          package: session.package,
          overwriteUser: args.overwriteUser !== false
        })
        events.push({
          type: 'plugin_installed',
          sessionId,
          step,
          package: session.package,
          descriptor
        })
        return {
          ok: true,
          content: `已安装插件：${descriptor.name}`,
          events
        }
      }

      case 'plugin_finish': {
        const summary = typeof args.summary === 'string' ? args.summary : '完成'
        const success = args.success === true
        const finishEvents =
          session.lastVerification?.items?.length
            ? syncSupportedFieldsAfterVerification(session, step, session.lastVerification.items)
            : []
        return {
          ok: true,
          content: summary,
          finish: { success, summary },
          events: finishEvents
        }
      }

      case 'browser_fetch_page': {
        const url = typeof args.url === 'string' ? args.url.trim() : ''
        if (!url) return { ok: false, content: 'url 必填' }
        return withBrowserLock(sessionId, async () => {
          const settings = getSettings()
          await scrapeBrowser.setProxy(resolveScrapeProxyUrl(settings))
          await scrapeBrowser.fetchPage(url, {
            readySelector:
              typeof args.readySelector === 'string' ? args.readySelector : 'body',
            timeoutMs:
              typeof args.timeoutMs === 'number' ? Math.round(args.timeoutMs) : 45000
          })
          const status = (await scrapeBrowser.performAction('status', {})) as {
            isChallenge?: boolean
            url?: string
            title?: string
          }
          if (status.isChallenge) {
            return {
              ok: false,
              content: JSON.stringify({
                code: 'CHALLENGE',
                message: '当前页面为 Cloudflare 挑战，请在浏览器窗口完成验证后请用户继续',
                ...status
              })
            }
          }
          const page = await refreshVerificationPageFromBrowser(session, '验证参考页')
          return {
            ok: true,
            content: JSON.stringify(
              {
                ...status,
                verificationPage: page
                  ? { url: page.url, title: page.title, textPreview: page.text.slice(0, 180) }
                  : undefined
              },
              null,
              2
            )
          }
        })
      }

      case 'browser_html': {
        return withBrowserLock(sessionId, async () => {
          const result = await scrapeBrowser.performAction('htmlRegion', {
            selector: typeof args.selector === 'string' ? args.selector : 'body',
            maxLength:
              typeof args.maxLength === 'number'
                ? args.maxLength
                : session.limits.maxHtmlChars
          })
          return { ok: true, content: JSON.stringify(result, null, 2) }
        })
      }

      case 'browser_inspect': {
        return withBrowserLock(sessionId, async () => {
          const raw = await scrapeBrowser.performAction('inspect', {
            maxTextLength:
              typeof args.maxTextLength === 'number' ? args.maxTextLength : 6000,
            maxLinks: typeof args.maxLinks === 'number' ? args.maxLinks : 100
          })
          const page = normalizeInsight('浏览器当前页', raw)
          session.lastInspectPage = page
          return {
            ok: true,
            content: formatPageInsightForPrompt(page, { textLimit: 3200, linkLimit: 40 })
          }
        })
      }

      case 'browser_evaluate': {
        const expression = typeof args.expression === 'string' ? args.expression : ''
        if (!expression.trim()) return { ok: false, content: 'expression 必填' }
        return withBrowserLock(sessionId, async () => {
          const value = await scrapeBrowser.performAction('evaluate', { expression })
          return { ok: true, content: JSON.stringify(value, null, 2) }
        })
      }

      case 'browser_click': {
        const selector = typeof args.selector === 'string' ? args.selector : ''
        if (!selector) return { ok: false, content: 'selector 必填' }
        return withBrowserLock(sessionId, async () => {
          await scrapeBrowser.performAction('click', { selector })
          return { ok: true, content: `已点击 ${selector}` }
        })
      }

      case 'browser_type': {
        const selector = typeof args.selector === 'string' ? args.selector : ''
        const text = typeof args.text === 'string' ? args.text : ''
        if (!selector) return { ok: false, content: 'selector 必填' }
        return withBrowserLock(sessionId, async () => {
          await scrapeBrowser.performAction('type', {
            selector,
            text,
            clear: args.clear === true
          })
          return { ok: true, content: `已向 ${selector} 输入文本` }
        })
      }

      case 'browser_press': {
        const key = typeof args.key === 'string' ? args.key : 'Enter'
        return withBrowserLock(sessionId, async () => {
          await scrapeBrowser.performAction('press', { key })
          return { ok: true, content: `已按键 ${key}` }
        })
      }

      case 'browser_wait': {
        const timeoutMs =
          typeof args.timeoutMs === 'number' ? Math.round(args.timeoutMs) : 1000
        return withBrowserLock(sessionId, async () => {
          await scrapeBrowser.performAction('wait', { timeoutMs })
          return { ok: true, content: `已等待 ${timeoutMs}ms` }
        })
      }

      case 'browser_status': {
        return withBrowserLock(sessionId, async () => {
          const status = await scrapeBrowser.performAction('status', {})
          return { ok: true, content: JSON.stringify(status, null, 2) }
        })
      }

      case 'session_note': {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (!text) return { ok: false, content: 'text 必填' }
        session.pageNotes.push({ text, at: Date.now() })
        return { ok: true, content: '已记录笔记' }
      }

      case 'session_request_user': {
        const reason = typeof args.reason === 'string' ? args.reason : '需要用户操作'
        session.status = 'waiting_user'
        events.push({
          type: 'waiting_user',
          sessionId,
          step,
          reason
        })
        return {
          ok: true,
          content: reason,
          waitForUser: reason,
          events
        }
      }

      default:
        return { ok: false, content: `未知工具：${toolName}` }
    }
  } catch (err) {
    return toolError('TOOL_ERROR', err instanceof Error ? err.message : String(err))
  }
}
