import TextInput from '../TextInput'
import TextArea from '../TextArea'
import { useState } from 'react'
import { getPluginDevKindProfile, parseTestTargetList } from '@shared/pluginDevKindProfile'
import type { PluginKind } from './types'
import SelectControl from '../SelectControl'
import PluginDevFieldTags from './PluginDevFieldTags'
import PluginDevMediaTargetPicker from './PluginDevMediaTargetPicker'
import { WorkbenchRail, WorkbenchRailHeader } from '../workbench'
import Button from '../Button'
import styles from './PluginDevConfigRail.module.css'

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
        <abbr className={styles.controlMark} title="必填">
          *
        </abbr>
      ) : null}
    </span>
  )
}

function pluginDevControlClass(required: boolean, attention: boolean): string {
  const classes = [styles.control, styles.primary]
  if (required) classes.push(styles.controlRequired)
  if (attention) classes.push(styles.controlAttention)
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
  forkedFromBuiltIn,
  selectedPluginName,
  selectablePlugins,
  pluginsLoading,
  busy,
  canUseAgent,
  hasPackage,
  canResumeAgent,
  agentCompleted,
  agentReady,
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
  forkedFromBuiltIn: string | null
  selectedPluginName: string
  selectablePlugins: Array<{ name: string; source: 'user' | 'builtin' }>
  pluginsLoading: boolean
  busy: boolean
  canUseAgent: boolean
  hasPackage: boolean
  canResumeAgent: boolean
  agentCompleted: boolean
  agentReady: boolean
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
  const isDebugMode = Boolean(loadedInstalledName || forkedFromBuiltIn)
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
        : agentReady
          ? '输入反馈后继续'
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
    <WorkbenchRail className={styles.rail}>
      <WorkbenchRailHeader>
        <span>任务配置</span>
        {isDebugMode ? <span className={styles.modeBadge}>调试模式</span> : null}
      </WorkbenchRailHeader>

      <div className={styles.scroll} data-plugin-dev-config-scroll>
        {agentDisabledReason ? (
          <div className={styles.attention} data-plugin-dev-attention>
            <strong>{activeLlmReady ? '下一步' : '模型未就绪'}</strong>
            <span>{agentDisabledReason}</span>
          </div>
        ) : null}
        <label className={`${styles.control} ${styles.primary}`}>
          <span>{isDebugMode ? '调试插件' : '插件来源'}</span>
          <SelectControl
            value={selectedPluginName}
            disabled={busy || pluginsLoading}
            onChange={(e) => onSelectPlugin(e.target.value)}
          >
            <option value="">新建插件</option>
            {selectablePlugins.map((plugin) => (
              <option key={plugin.name} value={plugin.name}>
                {plugin.source === 'builtin' ? `${plugin.name}（内置）` : plugin.name}
              </option>
            ))}
          </SelectControl>
          {pluginsLoading && <span className={styles.selectHint}>加载中…</span>}
          {!pluginsLoading && selectablePlugins.length === 0 && (
            <span className={styles.selectHint}>暂无已安装的插件</span>
          )}
          {forkedFromBuiltIn ? (
            <span className={styles.selectHint}>
              来自内置「{forkedFromBuiltIn}」的草稿，须使用新名称安装，不会覆盖原插件
            </span>
          ) : null}
        </label>

        <label className={`${styles.control} ${styles.primary}`}>
          <span>插件名</span>
          <TextInput
            density="workspace" className={styles.textInput}
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
          <TextInput
            density="workspace" className={styles.textInput}
            value={siteUrl}
            placeholder="https://example.com"
            disabled={busy}
            aria-required={siteUrlRequired}
            onChange={(e) => onSiteUrlChange(e.target.value)}
          />
          {siteUrlRequired ? (
            <small className={styles.controlHint}>新建插件时必填，填写目标站点首页地址</small>
          ) : null}
        </label>

        <div
          className={pluginDevControlClass(
            testTargetRequired,
            testTargetRequired && !hasTestTarget
          )}
        >
          <div className={styles.controlHeading}>
            <PluginDevFieldLabel required={testTargetRequired}>
              {profile.testTargetLabel}
            </PluginDevFieldLabel>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setShowTargetPicker(true)}
            >
              从媒体库选择
            </Button>
          </div>
          <TextArea
            density="workspace" className={`${styles.textInput} ${styles.textarea} ${styles.textareaMini}`}
            value={testTarget}
            placeholder={
              isDebugMode
                ? `填写一个或多个${profile.testTargetShortLabel}；多个用换行或逗号分隔`
                : `可选；多个${profile.testTargetShortLabel}可用换行或逗号分隔`
            }
            disabled={busy}
            aria-required={testTargetRequired}
            onChange={(e) => onTestTargetChange(e.target.value)}
          />
          <small className={styles.controlHint}>
            {isDebugMode
              ? `调试时必填，用于 Agent 验证插件解析是否正确`
              : `AI 开发可不填；填写后 Agent 会优先使用这些${profile.testTargetShortLabel}验证`}
            {testTargetCount > 1 ? `；已填写 ${testTargetCount} 个目标` : ''}
          </small>
        </div>

        <label className={styles.control}>
          <span>需求说明</span>
          <TextArea
            density="workspace" className={`${styles.textInput} ${styles.textarea} ${styles.textareaShort}`}
            value={description}
            placeholder="可选：描述站点特点或解析难点"
            disabled={busy}
            onChange={(e) => onDescriptionChange(e.target.value)}
          />
        </label>

        <div className={styles.metaRow}>
          <label className={styles.control}>
            <span>版本</span>
            <TextInput
              density="workspace" className={styles.textInput}
              value={version}
              disabled={busy}
              onChange={(e) => onVersionChange(e.target.value)}
            />
          </label>
          <label className={styles.control}>
            <span>作者</span>
            <TextInput
              density="workspace" className={styles.textInput}
              value={author}
              disabled={busy}
              onChange={(e) => onAuthorChange(e.target.value)}
            />
          </label>
        </div>

        {!hasPackage && !isDebugMode ? (
          <div className={styles.control}>
            <span>支持字段</span>
            <small className={styles.controlHint}>
              Create 模式不预设字段；Agent 将根据详情页自行探索并填写最终支持字段。
            </small>
          </div>
        ) : (
          <PluginDevFieldTags
            className={styles.fieldTags}
            kind={kind}
            supportedFieldIds={supportedFields}
            fieldLabel={fieldLabel}
            busy={busy}
            onChange={onSupportedFieldsChange}
          />
        )}
      </div>

      <div className={styles.actions}>
        <Button
          type="button"
          variant={canInstall ? 'default' : 'primary'}
          size="sm"
          className={styles.actionButton}
          disabled={busy || !canUseAgent || agentBusy || Boolean(agentPrimaryDisabledReason)}
          title={agentPrimaryDisabledReason ?? undefined}
          onClick={onStartAgent}
        >
          {agentButtonLabel}
        </Button>
        <Button
          type="button"
          variant={canInstall ? 'primary' : 'default'}
          size="sm"
          className={styles.actionButton}
          disabled={busy || !hasPackage || !canInstall}
          onClick={onInstall}
        >
          {installBusy ? '安装中…' : loadedInstalledName ? '更新安装' : '安装'}
        </Button>
      </div>
      {showTargetPicker ? (
        <PluginDevMediaTargetPicker
          kind={kind}
          selectedValues={parseTestTargetList(testTarget)}
          onAdd={appendTestTarget}
          onClose={() => setShowTargetPicker(false)}
        />
      ) : null}
    </WorkbenchRail>
  )
}
