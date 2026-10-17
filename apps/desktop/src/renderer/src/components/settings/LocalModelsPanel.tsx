import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AudioLines, ChevronDown, ChevronRight, Download, Ellipsis, FileSearch, FolderInput, FolderOutput, Link, Settings2, TextCursorInput, Trash2, Wrench } from 'lucide-react'
import type { LocalModelCommand, LocalModelGroup, LocalModelId, LocalModelSnapshot, LocalModelVariantView, LocalModelView } from '@shared/desktop/localModels'
import Button from '../Button'
import FloatingLayer from '../FloatingLayer'
import IconButton from '../IconButton'
import Modal from '../Modal'
import SelectControl from '../SelectControl'
import { useToast } from '../Toast'
import { DetailMenuItem, DetailMenuSeparator } from '../DetailMenu'
import { UI_ICON_SM } from '../iconDefaults'
import { modelUsageLocation } from '../../settings/settingsRoutes'
import { useLocalModels } from './useLocalModels'
import { SettingsCard, SettingsDisclosure, SettingsStatusPill, SettingsValueRow } from './SettingsPrimitives'
import styles from './LocalModelsPanel.module.css'
import LocalAccelerationPanel from './LocalAccelerationPanel'
import LocalModelStoragePanel from './LocalModelStoragePanel'
import LocalModelStatus, { executionLabel } from './LocalModelStatus'
import LocalRuntimeEnvironment, { PreparationItems, preparationProgressLabel } from './LocalRuntimeEnvironment'
import LocalModelOperationFeedback, { failureGroup, failureModel, type ModelOperationFailure } from './LocalModelOperationFeedback'

type Execute = (command: LocalModelCommand) => Promise<boolean>
function matchesVariant(variant: LocalModelVariantView, filter: string): boolean {
  return filter === 'all' || (filter === 'selected' ? variant.references.length > 0 : filter === 'partial' ? !!variant.hasFiles && !variant.installed : variant.installed)
}
function expandedByDefault(model: LocalModelView, filter: string): boolean {
  return filter !== 'all' || model.inUse || model.variants.some(variant => variant.references.length > 0)
}
interface ModelProps {
  model: LocalModelView
  state: LocalModelSnapshot
  busy: boolean
  execute: Execute
  requestDelete: (model: LocalModelView, variant: LocalModelVariantView) => void
  requestDetails: (model: LocalModelView, variant: LocalModelVariantView) => void
  requestEnvironment: (group: LocalModelGroup) => void
  requestUsage: (model: LocalModelView, variant: LocalModelVariantView) => void
  failure?: ModelOperationFailure
  requestError: () => void
}

function VariantActions({ model, variant, state, busy, execute, requestDelete, requestDetails, requestEnvironment, requestUsage, failure }: ModelProps & { variant: LocalModelVariantView }): JSX.Element {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const working = busy || state.operation !== null
  const sharedRuntimeInUse = state.models.some(item => item.id !== 'kotoba' && item.inUse)
  const repairing = state.operation === 'download' && state.activeVariant === variant.id
  const deletionReason = variant.inUse ? '当前任务正在使用此精度。' : ''
  const failedDownload = failure?.command.action === 'download' && failure.command.variant === variant.id
  const needsRepair = variant.hasFiles && variant.preparation?.downloadBytes === variant.bytes
  const downloadAction = variant.installed ? '模型已下载' : failedDownload || needsRepair ? '重试下载' : variant.hasFiles ? '继续下载' : '下载模型'
  function checkEnvironment(): boolean {
    const group = model.id === 'kotoba' ? 'speech' : 'text'
    const baseReady = state.environments?.find(item => item.group === group)?.cpuReady ?? variant.runtimeReady ?? true
    if (state.supported && !baseReady) { requestEnvironment(group); return false }
    return true
  }
  function download(): void {
    if (open) anchorRef.current?.focus()
    setOpen(false)
    if (!checkEnvironment()) return
    void execute({ action: 'download', model: model.id, variant: variant.id })
  }
  function run(action: 'copy-download-url' | 'import' | 'export'): void {
    if (action === 'import' && open) anchorRef.current?.focus()
    setOpen(false)
    if (action === 'import' && !checkEnvironment()) return
    void execute({ action, model: model.id, variant: variant.id }).then(ok => {
      if (ok && action === 'copy-download-url') toast.show('下载地址已复制', 'success')
    })
  }
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])
  return <div className={styles.variantActions}>
    <IconButton size="control" icon={<Download {...UI_ICON_SM} />} label={`${model.name} ${variant.precision} ${variant.publisher} ${downloadAction}`}
      title={variant.installed ? '模型已下载；可在更多操作中校验与修复' : downloadAction} aria-busy={repairing}
      disabled={variant.installed || working || state.checkingDependencies || model.inUse || (model.id !== 'kotoba' && sharedRuntimeInUse)} onClick={download} />
    <IconButton ref={anchorRef} size="control" icon={<Ellipsis {...UI_ICON_SM} />} label={`${model.name} ${variant.precision} ${variant.publisher} 更多操作`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)} />
    <FloatingLayer open={open} anchorRef={anchorRef} side="bottom" align="end" id={menuId} role="menu" className={styles.menu}
      ariaLabel={`${model.name} ${variant.precision} ${variant.publisher} 操作`} onClose={() => setOpen(false)}>
      <div ref={menuRef} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== anchorRef.current) setOpen(false)
      }} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        if (!items.length) return
        event.preventDefault()
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next].focus()
      }}>
        <div className={styles.menuHeading}><strong>{variant.precision}</strong><span>{variant.publisher}</span></div>
        <DetailMenuItem className={styles.menuItem} onClick={() => { anchorRef.current?.focus(); setOpen(false); requestDetails(model, variant) }}>
          <FileSearch {...UI_ICON_SM} />精度与验证详情
        </DetailMenuItem>
        <DetailMenuItem className={styles.menuItem} onClick={() => { setOpen(false); requestUsage(model, variant) }}><Settings2 {...UI_ICON_SM} />前往用途配置</DetailMenuItem>
        {variant.installed && <DetailMenuItem disabled={working || model.inUse || (model.id !== 'kotoba' && sharedRuntimeInUse)} aria-busy={repairing}
          className={styles.menuItem} onClick={download}><Wrench {...UI_ICON_SM} />校验与修复</DetailMenuItem>}
        <DetailMenuSeparator />
        <DetailMenuItem className={styles.menuItem} disabled={busy} onClick={() => run('copy-download-url')}><Link {...UI_ICON_SM} />复制下载地址</DetailMenuItem>
        <DetailMenuItem className={styles.menuItem} disabled={working || state.checkingDependencies || variant.inUse} onClick={() => run('import')}><FolderInput {...UI_ICON_SM} />导入模型文件</DetailMenuItem>
        {variant.installed && <DetailMenuItem className={styles.menuItem} disabled={working} onClick={() => run('export')}><FolderOutput {...UI_ICON_SM} />导出模型文件</DetailMenuItem>}
        {(variant.installed || variant.hasFiles) && <DetailMenuSeparator />}
        {(variant.installed || variant.hasFiles) && <DetailMenuItem className={styles.menuItem} danger disabled={working || variant.inUse}
          onClick={() => { anchorRef.current?.focus(); setOpen(false); requestDelete(model, variant) }}><Trash2 {...UI_ICON_SM} />删除此精度</DetailMenuItem>}
        {(variant.installed || variant.hasFiles) && deletionReason && <p className={styles.menuHint}>{deletionReason}</p>}
      </div>
    </FloatingLayer>
  </div>
}

function ModelFamily({ model, state, busy, execute, requestDelete, requestDetails, requestEnvironment, requestUsage, failure, requestError, expanded, onToggle, targetVariant, filter }: ModelProps & {
  expanded: boolean; onToggle: () => void; targetVariant?: string | null; filter: string
}): JSX.Element {
  const tableId = useId()
  const targetRef = useRef<HTMLTableRowElement>(null)
  const variants = model.variants.filter(variant => matchesVariant(variant, filter))
    .sort((a, b) => Number(b.references.length > 0) - Number(a.references.length > 0))
  useEffect(() => {
    if (expanded && targetVariant) targetRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [expanded, targetVariant])
  return <article className={styles.family} aria-label={`${model.name} 模型文件`}>
    <Button variant="ghost" className={styles.familyHeader} aria-label={`${model.name} 精度列表`} data-model-family-header={model.id}
      aria-expanded={expanded} aria-controls={tableId} onClick={onToggle}>
      {expanded ? <ChevronDown {...UI_ICON_SM} /> : <ChevronRight {...UI_ICON_SM} />}
      <strong className={styles.familyName}>{model.name}</strong>
      <span className={styles.familySummary}>{model.purpose} · {model.variants.length} 个精度 · 已下载 {model.variants.filter(variant => variant.installed).length}
        {model.variants.some(variant => variant.hasFiles && !variant.installed) && ` · 未完成 ${model.variants.filter(variant => variant.hasFiles && !variant.installed).length}`}</span>
    </Button>
    {expanded && <div className={styles.tableScroll} id={tableId} role="region" aria-label={`${model.name} 精度表格，可横向滚动`} tabIndex={0}>
      <table className={styles.table} aria-label={`${model.name} 精度列表`}>
        <colgroup><col className={styles.precisionColumn} /><col className={styles.fileColumn} /><col className={styles.purposeColumn} />
          <col className={styles.validationColumn} /><col className={styles.actionColumn} /></colgroup>
        <thead><tr>{['精度', '模型文件', '用途绑定', '配置验证', '操作'].map(label => <th key={label} scope="col" className={styles.columnHead}>{label}</th>)}</tr></thead>
        <tbody>{variants.map(variant => <Fragment key={variant.id}>
          <tr data-variant={variant.id} data-model-variant={variant.id} data-selected={variant.references.length > 0 || undefined}
            data-target={variant.id === targetVariant || undefined} ref={variant.id === targetVariant ? targetRef : undefined} className={styles.variantRow}>
            <th scope="row" className={`${styles.cell} ${styles.precisionCell}`}><div className={styles.identity}>
              <div className={styles.tags}><span className={styles.precisionTag}>{variant.precision}</span>
                {variant.inUse && <span role="status" title={executionLabel(variant.execution)}><SettingsStatusPill status="info">
                  {variant.execution?.backend === 'cpu' ? 'CPU 使用中' : variant.execution && variant.execution.backend !== 'idle' ? 'GPU 使用中' : '使用中'}
                </SettingsStatusPill></span>}
                {variant.recommended && <span className={styles.recommended} title="此模型默认推荐的精度；文件大小不代表运行内存需求">推荐</span>}</div>
              <span className={styles.publisher}>{variant.publisher}</span>
            </div></th>
            <LocalModelStatus {...{ model, variant, state, busy, execute }} />
            <td className={`${styles.cell} ${styles.actionCell}`}><VariantActions {...{ model, variant, state, busy, execute, requestDelete, requestDetails, requestEnvironment, requestUsage, failure, requestError }} /></td>
          </tr>
          {failureModel(failure) === model.id && failure && 'variant' in failure.command && failure.command.variant === variant.id && !state.operation && <tr><td colSpan={5} className={styles.progressCell}>
            <LocalModelOperationFeedback failure={failure} disabled={busy || model.inUse} execute={execute} details={requestError} />
          </td></tr>}
          {state.operation === 'download' && state.activeVariant === variant.id && <tr><td colSpan={5} className={styles.progressCell}>
            <div className={styles.modelProgress} role="status">
              <span>{preparationProgressLabel(state)}</span>
              <progress aria-label={`${model.name} ${variant.precision} 下载进度`} max={state.downloadTotal || 1} value={state.downloadBytes} />
              <Button size="sm" disabled={busy} onClick={() => void execute({ action: 'cancel-download' })}>取消下载</Button>
            </div>
          </td></tr>}
        </Fragment>)}</tbody>
      </table>
    </div>}
  </article>
}

export default function LocalModelsPanel(): JSX.Element {
  const { state, busy, error, errorCommand, snapshotError, execute } = useLocalModels()
  const location = useLocation()
  const navigate = useNavigate()
  const query = new URLSearchParams(location.search)
  const targetModel = query.get('model') as LocalModelId | null
  const targetVariant = query.get('variant')
  const [expanded, setExpanded] = useState<Partial<Record<LocalModelId, boolean>>>({})
  const [filters, setFilters] = useState({ speech: 'all', text: 'all' })
  const [showError, setShowError] = useState(false)
  const [inspecting, setInspecting] = useState<{ model: LocalModelId; variant: string } | null>(null)
  const [deleting, setDeleting] = useState<{ model: LocalModelView; variant: LocalModelVariantView } | null>(null)
  const [requiredEnvironment, setRequiredEnvironment] = useState<LocalModelGroup | null>(null)
  const activeModelId = state?.activeModel, activeVariantId = state?.activeVariant
  useEffect(() => {
    if (activeModelId && activeVariantId) setExpanded(value => ({ ...value, [activeModelId]: true }))
  }, [activeModelId, activeVariantId])
  useEffect(() => {
    if (!targetModel) return
    setExpanded(value => ({ ...value, [targetModel]: true }))
    setFilters(value => ({ ...value, [targetModel === 'kotoba' ? 'speech' : 'text']: 'all' }))
  }, [targetModel, targetVariant])
  if (!state) return <p role="status">{error || '正在读取本地模型…'}</p>
  const working = busy || state.operation !== null
  const anyInUse = state.models.some(model => model.inUse)
  const currentError = error || snapshotError || state.acceleration?.error
  const failure = error && errorCommand ? { message: error, command: errorCommand } : snapshotError ? state.operationError : undefined
  const matchesFilter = (model: LocalModelView, filter: string): boolean => model.variants.some(variant => matchesVariant(variant, filter))
  const storageError = currentError && !failureModel(failure) && !failureGroup(failure)
    && !['acceleration', 'detect-devices'].includes(failure?.command.action ?? '') ? currentError : null
  function returnToUsage(): void {
    navigate(modelUsageLocation(location.search))
  }
  function locateFiles(group: LocalModelGroup, variant?: string): void {
    const model = state!.models.find(item => item.variants.some(entry => entry.id === variant))
      ?? state!.models.find(item => (item.id === 'kotoba') === (group === 'speech') && item.variants.some(entry => entry.hasFiles || entry.installed))
    setFilters(value => ({ ...value, [group]: 'all' }))
    setExpanded(value => ({ ...value, ...Object.fromEntries(state!.models.filter(item => (item.id === 'kotoba') === (group === 'speech')).map(item => [item.id, true])) }))
    if (model) {
      const next = new URLSearchParams(location.search)
      next.set('model', model.id); next.set('variant', variant ?? model.variants.find(entry => entry.hasFiles || entry.installed)!.id)
      navigate({ pathname: location.pathname, search: `?${next}` }, { replace: true })
    }
  }
  const deletingVariant = deleting && state.models.find(model => model.id === deleting.model.id)?.variants.find(variant => variant.id === deleting.variant.id)
  const inspectedModel = inspecting && state.models.find(model => model.id === inspecting.model)
  const inspected = inspectedModel?.variants.find(variant => variant.id === inspecting?.variant)
  return <div className={styles.root}>
    <LocalAccelerationPanel state={state} disabled={working || anyInUse} execute={execute} failure={failure} requestError={() => setShowError(true)} />
    {([{ id: 'speech', title: '语音模型', icon: <AudioLines {...UI_ICON_SM} />, models: state.models.filter(model => model.id === 'kotoba') },
      { id: 'text', title: '文本模型', icon: <TextCursorInput {...UI_ICON_SM} />, models: state.models.filter(model => model.id !== 'kotoba') }] as const).map(group => {
      const models = [...group.models].filter(model => matchesFilter(model, filters[group.id]))
        .sort((a, b) => Number(b.variants.some(variant => variant.references.length)) - Number(a.variants.some(variant => variant.references.length)))
      return <SettingsCard as="section" key={group.id} aria-label={group.title} title={<span className={styles.title}>{group.icon}{group.title}</span>}
        hint="管理模型文件、精度与运行状态；用途在“功能”中配置。" actions={<>
          <SelectControl aria-label={`${group.title}筛选`} value={filters[group.id]}
            onChange={event => setFilters(value => ({ ...value, [group.id]: event.target.value }))}>
            <option value="all">全部精度</option><option value="selected">当前选用</option><option value="installed">已下载</option><option value="partial">未完成下载</option>
          </SelectControl>
          {targetModel && group.models.some(model => model.id === targetModel) && <Button size="sm" onClick={returnToUsage}>返回用途配置</Button>}
        </>}>
        {state.environments?.find(environment => environment.group === group.id) && <LocalRuntimeEnvironment
          environment={state.environments.find(environment => environment.group === group.id)!} state={state} disabled={working || anyInUse} execute={execute}
          failure={failure} requestError={() => setShowError(true)} requestFiles={variant => locateFiles(group.id, variant)} />}
        {models.length ? models.map(model => <ModelFamily key={model.id} {...{ model, state, busy, execute }}
          filter={filters[group.id]} expanded={expanded[model.id] ?? expandedByDefault(model, filters[group.id])} targetVariant={model.id === targetModel ? targetVariant : undefined}
          onToggle={() => setExpanded(value => ({ ...value, [model.id]: !(value[model.id] ?? expandedByDefault(model, filters[group.id])) }))}
          requestDelete={(family, variant) => setDeleting({ model: family, variant })}
          requestEnvironment={setRequiredEnvironment}
          failure={failure} requestError={() => setShowError(true)}
          requestUsage={(family, variant) => navigate(modelUsageLocation(location.search, family.id === 'kotoba' || state.usage.subtitleTranslation.variant === variant.id ? 'ai-subtitles' : 'text-translation'))}
          requestDetails={(family, variant) => setInspecting({ model: family.id, variant: variant.id })} />)
          : <p className={styles.note}>暂无符合筛选条件的模型。</p>}
      </SettingsCard>
    })}
    <LocalModelStoragePanel state={state} busy={busy} execute={execute} error={storageError} requestError={() => setShowError(true)} />
    {showError && <Modal title="本地模型操作失败" hideActions onCancel={() => setShowError(false)}>
      <p className={styles.fullError}>{currentError || '错误已解除。'}</p>
      {failure && <LocalModelOperationFeedback failure={failure} showMessage={false} detailsLabel="查看对应位置" disabled={working || anyInUse} execute={async command => { setShowError(false); return execute(command) }} details={() => {
        setShowError(false)
        const command = failure.command
        const group = failureGroup(failure)
        if (group) document.querySelector(`[data-runtime-group="${group}"]`)?.scrollIntoView({ block: 'center' })
        else if ('model' in command && command.model) locateFiles(command.model === 'kotoba' ? 'speech' : 'text', 'variant' in command ? command.variant : undefined)
        else if (['acceleration', 'detect-devices', 'prepare-acceleration'].includes(command.action)) document.querySelector('[aria-label="本地模型计算设备"]')?.scrollIntoView({ block: 'center' })
        else document.querySelector('[aria-label="存储与维护"]')?.scrollIntoView({ block: 'center' })
      }} />}
    </Modal>}
    {requiredEnvironment && <Modal title="请先安装运行环境" confirmText="安装基础运行环境" busy={busy}
      confirmDisabled={working || anyInUse || state.checkingDependencies}
      onCancel={() => setRequiredEnvironment(null)} onConfirm={async () => {
        if (await execute({ action: 'prepare-runtime', group: requiredEnvironment, target: 'cpu' })) setRequiredEnvironment(null)
      }}>
      <p>下载或导入模型前，请先安装{requiredEnvironment === 'speech' ? '语音' : '文本'}模型的基础运行环境。仅安装基础环境即可使用 CPU，GPU 加速支持可选。</p>
      <p>本次只安装环境；完成后请再次选择下载或导入。</p>
      {currentError && <p role="alert" className={styles.fullError}>{currentError}</p>}
    </Modal>}
    {inspected && inspectedModel && <Modal title="精度与验证详情" size="lg" className={styles.precisionDetails} hideActions onCancel={() => setInspecting(null)}>
      <p className={styles.path}>{inspectedModel.name} · {inspected.precision} · {inspected.publisher}</p>
      <SettingsValueRow label="模型文件" value={`${inspected.installed ? '已下载' : inspected.hasFiles ? '部分文件' : '未下载'} · ${(inspected.bytes / 1e9).toFixed(2)} GB · ${inspected.format}`} />
      <SettingsValueRow label="用途绑定" value={inspected.references.join('、') || '未绑定用途'} />
      {inspected.dependencies && <SettingsValueRow label="依赖检查" value={inspected.dependencies.message} />}
      <SettingsValueRow label="配置验证" value={inspected.validation?.state === 'passed' ? `试运行通过 · ${executionLabel(inspected.validation.execution)}`
        : inspected.validation?.state === 'failed' ? '验证失败' : inspected.validation?.state === 'checking' ? '正在验证'
          : inspected.validation?.state === 'waiting' ? '等待自动验证' : '未验证'} />
      {inspected.validation?.checkedAt && <SettingsValueRow label="检查时间" value={new Date(inspected.validation.checkedAt).toLocaleString()} />}
      {(inspected.validation?.message || inspected.validation?.execution?.reason) && <p className={styles.path}>
        {inspected.validation.message ?? inspected.validation.execution?.reason}</p>}
      <SettingsValueRow label="当前任务" value={inspected.inUse ? executionLabel(inspected.execution) : '空闲'} />
      {inspected.inUse && inspected.execution?.reason && <p className={styles.path}>{inspected.execution.reason}</p>}
      {inspected.preparation && <SettingsDisclosure title="模型文件清单" defaultOpen>
        <PreparationItems plan={inspected.preparation} />
      </SettingsDisclosure>}
      <SettingsDisclosure title="来源、校验与适用范围">
        <p className={styles.path}>{inspected.source}</p>
        <p>固定版本：{inspectedModel.version}。下载及导入均核验对应精度和发布者的 SHA-256；导入会复制文件，原文件保留。导出不包含运行依赖和缓存，分发请遵守上游许可证。文件大小不是运行内存需求。</p>
        {inspected.references.length > 0 && <p>删除此精度会使相关用途暂不可用；用途选择会保留，重新安装后恢复。</p>}
        {inspectedModel.id === 'kotoba' && <p>日语语音转写使用 Kotoba v2.0；中文翻译由单独的文本模型负责。</p>}
        {inspectedModel.id === 'hy-mt2-7b' && <p>腾讯官方 GGUF，Apache-2.0。当前目录只收录已有完整校验信息的精度。</p>}
      </SettingsDisclosure>
    </Modal>}
    {deleting && <Modal title="删除模型精度" confirmText="删除此精度" danger busy={busy}
      confirmDisabled={state.operation !== null || !deletingVariant || deletingVariant.inUse}
      onCancel={() => setDeleting(null)} onConfirm={async () => {
        if (await execute({ action: 'delete', model: deleting.model.id, variant: deleting.variant.id })) setDeleting(null)
      }}><p className={styles.path}>{deleting.model.name} · {deleting.variant.precision} · {deleting.variant.publisher}</p>
      <p>只删除此精度的模型文件，保留运行依赖与其他精度。重新使用时需要再次下载或导入。</p>
      {deletingVariant?.references.length ? <p role="alert">{deletingVariant.references.join('、')}正在选用此精度，删除后将暂不可用。用途选择会保留，重新安装后恢复。</p> : null}
      {currentError && <p role="alert" className={styles.fullError}>{currentError}</p>}
    </Modal>}
  </div>
}
