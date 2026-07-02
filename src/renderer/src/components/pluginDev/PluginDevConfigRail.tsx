import { useState } from 'react'
import { getPluginDevKindProfile, parseTestTargetList } from '@shared/pluginDevKindProfile'
import type { PluginKind } from './types'
import PluginDevFieldTags from './PluginDevFieldTags'
import PluginDevMediaTargetPicker from './PluginDevMediaTargetPicker'

function PluginDevFieldLabel({
  children,
  required
}: {
  children: string
  required?: boolean
}): JSX.Element {
  return (
    <span>
      {children}
      {required ? (
        <abbr className="plugin-edit-control-mark" title="必填">
          *
        </abbr>
      ) : null}
    </span>
  )
}

function pluginDevControlClass(required: boolean, attention: boolean): string {
  const classes = ['plugin-edit-control', 'plugin-dev-control--primary']
  if (required) classes.push('plugin-edit-control--required')
  if (attention) classes.push('plugin-edit-control--attention')
  return classes.join(' ')
}

export default function PluginDevConfigRail({
  kind,
  siteName,
  siteUrl,
  testTarget,
  description,
  version,
  author,
  supportedFields,
  fieldLabel,
  loadedInstalledName,
  selectedPluginName,
  userPluginNames,
  pluginsLoading,
  busy,
  canUseAgent,
  hasPackage,
  canResumeAgent,
  agentCompleted,
  feedbackPending,
  agentDisabledReason,
  agentPrimaryDisabledReason,
  activeLlmReady,
  agentBusy,
  installBusy,
  canInstall,
  onSelectPlugin,
  onStartAgent,
  onInstall,
  onSiteNameChange,
  onSiteUrlChange,
  onTestTargetChange,
  onDescriptionChange,
  onVersionChange,
  onAuthorChange,
  onSupportedFieldsChange
}: {
  kind: PluginKind
  siteName: string
  siteUrl: string
  testTarget: string
  description: string
  version: string
  author: string
  supportedFields: string[]
  fieldLabel: (kind: PluginKind, field: string) => string
  loadedInstalledName: string | null
  selectedPluginName: string
  userPluginNames: string[]
  pluginsLoading: boolean
  busy: boolean
  canUseAgent: boolean
  hasPackage: boolean
  canResumeAgent: boolean
  agentCompleted: boolean
  feedbackPending: boolean
  agentDisabledReason: string | null
  agentPrimaryDisabledReason: string | null
  activeLlmReady: boolean
  agentBusy: boolean
  installBusy: boolean
  canInstall: boolean
  onSelectPlugin: (name: string) => void
  onStartAgent: () => void
  onInstall: () => void
  onSiteNameChange: (value: string) => void
  onSiteUrlChange: (value: string) => void
  onTestTargetChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onVersionChange: (value: string) => void
  onAuthorChange: (value: string) => void
  onSupportedFieldsChange: (fieldIds: string[]) => void
}): JSX.Element {
  const [showTargetPicker, setShowTargetPicker] = useState(false)
  const profile = getPluginDevKindProfile(kind)
  const isDebugMode = Boolean(loadedInstalledName)
  const hasTestTarget = parseTestTargetList(testTarget).length > 0
  const testTargetCount = parseTestTargetList(testTarget).length
  const siteUrlRequired = !isDebugMode
  const testTargetRequired = isDebugMode
  const agentButtonLabel = agentBusy
    ? isDebugMode
      ? '调试中…'
      : '开发中…'
    : canResumeAgent
      ? feedbackPending
        ? '继续修复'
        : agentCompleted
          ? '已完成'
          : '继续 Agent'
    : isDebugMode
      ? 'AI调试'
      : hasPackage
        ? '继续开发'
      : 'AI开发'
  const appendTestTarget = (value: string): void => {
    const nextValue = value.trim()
    if (!nextValue) return
    const existingTargets = parseTestTargetList(testTarget)
    if (existingTargets.some((item) => item.toLowerCase() === nextValue.toLowerCase())) return
    onTestTargetChange([...existingTargets, nextValue].join(', '))
  }

  return (
    <aside className="plugin-dev-rail plugin-dev-rail--config">
      <div className="plugin-dev-rail-head">
        <span>任务配置</span>
        {isDebugMode ? <span className="plugin-dev-mode-badge">调试模式</span> : null}
      </div>

      <div className="plugin-dev-config-scroll">
        {agentDisabledReason ? (
          <div className="plugin-dev-config-attention">
            <strong>{activeLlmReady ? '下一步' : '模型未就绪'}</strong>
            <span>{agentDisabledReason}</span>
          </div>
        ) : null}
        <label className="plugin-edit-control plugin-dev-control--primary plugin-dev-plugin-select">
          <span>{isDebugMode ? '调试插件' : '插件来源'}</span>
          <select
            className="select"
            value={selectedPluginName}
            disabled={busy || pluginsLoading}
            onChange={(e) => onSelectPlugin(e.target.value)}
          >
            <option value="">新建插件</option>
            {userPluginNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {pluginsLoading && <span className="plugin-dev-plugin-select-hint">加载中…</span>}
          {!pluginsLoading && userPluginNames.length === 0 && (
            <span className="plugin-dev-plugin-select-hint">暂无已安装的插件</span>
          )}
        </label>

        <label className="plugin-edit-control plugin-dev-control--primary">
          <span>插件名</span>
          <input
            className="text-input"
            value={siteName}
            placeholder="可选，未填由 Agent 自动生成"
            disabled={busy}
            onChange={(e) => onSiteNameChange(e.target.value)}
          />
        </label>

        <label
          className={pluginDevControlClass(siteUrlRequired, siteUrlRequired && !siteUrl.trim())}
        >
          <PluginDevFieldLabel required={siteUrlRequired}>{profile.siteUrlLabel}</PluginDevFieldLabel>
          <input
            className="text-input"
            value={siteUrl}
            placeholder="https://example.com"
            disabled={busy}
            aria-required={siteUrlRequired}
            onChange={(e) => onSiteUrlChange(e.target.value)}
          />
          {siteUrlRequired ? (
            <small className="plugin-edit-control-hint">新建插件时必填，填写目标站点首页地址</small>
          ) : null}
        </label>

        <div
          className={pluginDevControlClass(
            testTargetRequired,
            testTargetRequired && !hasTestTarget
          )}
        >
          <div className="plugin-dev-control-heading">
            <PluginDevFieldLabel required={testTargetRequired}>
              {profile.testTargetLabel}
            </PluginDevFieldLabel>
            <button
              type="button"
              className="btn btn-ghost plugin-dev-target-picker-button"
              disabled={busy}
              onClick={() => setShowTargetPicker(true)}
            >
              从媒体库选择
            </button>
          </div>
          <textarea
            className="text-input plugin-dev-textarea plugin-dev-textarea--mini"
            value={testTarget}
            placeholder={
              isDebugMode
                ? `填写一个${profile.testTargetShortLabel}`
                : `可选；多个${profile.testTargetShortLabel}可用换行、空格或逗号分隔`
            }
            disabled={busy}
            aria-required={testTargetRequired}
            onChange={(e) => onTestTargetChange(e.target.value)}
          />
          <small className="plugin-edit-control-hint">
            {isDebugMode
              ? `调试时必填，用于 Agent 验证插件解析是否正确`
              : `AI 开发可不填；填写后 Agent 会优先使用这些${profile.testTargetShortLabel}验证`}
            {testTargetCount > 1 ? `；已填写 ${testTargetCount} 个目标` : ''}
          </small>
        </div>

        <label className="plugin-edit-control">
          <span>需求说明</span>
          <textarea
            className="text-input plugin-dev-textarea plugin-dev-textarea--short"
            value={description}
            placeholder="可选：描述站点特点或解析难点"
            disabled={busy}
            onChange={(e) => onDescriptionChange(e.target.value)}
          />
        </label>

        <div className="plugin-dev-meta-row">
          <label className="plugin-edit-control">
            <span>版本</span>
            <input
              className="text-input"
              value={version}
              disabled={busy}
              onChange={(e) => onVersionChange(e.target.value)}
            />
          </label>
          <label className="plugin-edit-control">
            <span>作者</span>
            <input
              className="text-input"
              value={author}
              disabled={busy}
              onChange={(e) => onAuthorChange(e.target.value)}
            />
          </label>
        </div>

        <PluginDevFieldTags
          kind={kind}
          supportedFieldIds={supportedFields}
          fieldLabel={fieldLabel}
          busy={busy}
          onChange={onSupportedFieldsChange}
        />
      </div>

      <div className="plugin-dev-config-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !canUseAgent || agentBusy || Boolean(agentPrimaryDisabledReason)}
          title={agentPrimaryDisabledReason ?? undefined}
          onClick={onStartAgent}
        >
          {agentButtonLabel}
        </button>
        <button
          type="button"
          className="btn btn-sm plugin-dev-config-actions-install"
          disabled={busy || !hasPackage || !canInstall}
          onClick={onInstall}
        >
          {installBusy ? '安装中…' : loadedInstalledName ? '更新安装' : '安装'}
        </button>
      </div>
      {showTargetPicker ? (
        <PluginDevMediaTargetPicker
          kind={kind}
          selectedValues={parseTestTargetList(testTarget)}
          onAdd={appendTestTarget}
          onClose={() => setShowTargetPicker(false)}
        />
      ) : null}
    </aside>
  )
}
