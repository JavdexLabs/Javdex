import { Fragment, useId, useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import type { LocalModelCommand, LocalModelSnapshot, LocalPreparationPlan, LocalRuntimeEnvironment as Environment } from '@shared/desktop/localModels'
import Button from '../Button'
import IconButton from '../IconButton'
import Modal from '../Modal'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsStatusPill } from './SettingsPrimitives'
import styles from './LocalModelsPanel.module.css'
import LocalModelOperationFeedback, { failureGroup, type ModelOperationFailure } from './LocalModelOperationFeedback'

export function preparationSize(bytes: number): string {
  if (bytes < 1e3) return `${bytes} B`
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
}
function fileSize(bytes: number): string {
  return bytes > 0 ? preparationSize(bytes) : '—'
}
function sourceName(source: string): string {
  try { return new URL(source).hostname }
  catch { return source || '平台组件' }
}
export function PreparationItems({ plan }: { plan: LocalPreparationPlan }) {
  return <div className={styles.preparationDetails}>
    <div className={styles.componentScroll} role="region" aria-label="下载准备清单，可横向滚动" tabIndex={0}>
      <table className={styles.componentTable} aria-label="下载准备清单">
        <thead className={styles.componentHead}><tr>{['文件或组件', '文件大小', '来源'].map(label => <th className={styles.componentCell} scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{plan.items.map(item => <tr className={styles.componentRow} key={item.id}>
          <th className={styles.componentCell} scope="row">{item.name}</th>
          <td className={styles.componentCell}>{fileSize(item.bytes)}</td><td className={styles.componentCell}>{sourceName(item.source)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>
}
export function preparationProgressLabel(state: LocalModelSnapshot): string {
  const phase = state.preparation?.phase
  return `${phase === 'checking' ? '校验文件' : phase === 'installing' ? '安装组件' : phase === 'downloading' ? '下载文件' : '下载 / 校验'} · ${state.downloadLabel ?? '本地模型'} · ${preparationSize(state.downloadBytes)} / ${preparationSize(state.downloadTotal)}`
}
export default function LocalRuntimeEnvironment({ environment, state, disabled, execute, requestFiles, failure, requestError }: {
  environment: Environment; state: LocalModelSnapshot; disabled: boolean; execute: (command: LocalModelCommand) => Promise<boolean>
  requestFiles: (variant?: string) => void; failure?: ModelOperationFailure; requestError: () => void
}) {
  const detailId = useId()
  const [expanded, setExpanded] = useState({ cpu: false, gpu: false })
  const [deleting, setDeleting] = useState<{ name: string; target: 'cpu' | 'gpu' } | null>(null)
  const [deleteError, setDeleteError] = useState(false)
  const { gpu } = environment
  const { supported, checkingDependencies: checking = false } = state
  const baseComponents = environment.components.filter(item => item.backend === 'cpu' || item.backend === 'common')
  const baseIds = new Set(baseComponents.map(item => item.id))
  const baseItems = environment.preparation.items.filter(item => baseIds.has(item.id))
  const basePlan = { ...environment.preparation, backend: 'cpu' as const, items: baseItems, downloadBytes: baseItems.reduce((sum, item) => sum + item.downloadBytes, 0) }
  const canInstallGpu = gpu.state === 'ready' || gpu.state === 'missing' || gpu.state === 'unchecked'
  const gpuPlan = environment.gpuPreparation
  const plannedGpuItems = gpuPlan.items.filter(item => !baseIds.has(item.id))
  const storedGpuComponents = environment.components.filter(item => !baseIds.has(item.id) && (item.installed || item.hasFiles))
  const gpuItems = canInstallGpu ? plannedGpuItems : storedGpuComponents.map(item => ({ ...item, action: item.installed ? 'reuse' as const : 'verify' as const, downloadBytes: 0 }))
  const device = state.acceleration?.devices.find(item => item.backend === gpu.backend && (state.acceleration?.policy.mode !== 'gpu' || item.id === state.acceleration.policy.device))
  const active = state.operation === 'download' ? state.preparation : undefined
  const completedIds = new Set(active?.plan.items.slice(0, active.completedItems).map(item => item.id))
  const missingDevice = state.acceleration?.policy.mode === 'gpu' && !state.acceleration.devices.some(item => item.id === state.acceleration!.policy.device)
  const gpuDescription = gpu.state === 'disabled' ? '当前使用 CPU，GPU 暂不使用。'
    : gpu.state === 'unavailable' ? missingDevice ? '指定显卡不可用，请重新选择运行方式。' : '未检测到可用独显，可使用 CPU。'
      : gpu.state === 'platform' ? gpu.backend === 'metal' ? 'Metal 由系统提供，无需单独安装。' : '当前平台使用基础运行环境。'
        : gpu.state === 'unchecked' ? '安装检测组件后继续识别显卡。'
          : [gpu.backend?.toUpperCase(), device?.name].filter(Boolean).join(' · ')
  const groupName = environment.group === 'speech' ? '语音' : '文本'
  const allComponents = state.environments?.flatMap(item => item.components) ?? environment.components
  const hasFiles = (component: Environment['components'][number]) => component.installed || component.hasFiles
  const deletingBase = deleting?.target === 'cpu'
  const deletingComponents = environment.components.filter(component => hasFiles(component)
    && (deletingBase ? baseIds.has(component.id) : !baseIds.has(component.id)))
  const remainingModels = state.models.filter(model => (model.id === 'kotoba') === (environment.group === 'speech'))
    .flatMap(model => model.variants.filter(variant => variant.installed || variant.hasFiles).map(variant => ({ model, variant })))
  const blocked = deletingBase && remainingModels.length > 0
  function requestDelete(name: string, target: 'cpu' | 'gpu'): void {
    setDeleteError(false); setDeleting({ name, target })
  }
  const rows = [
    { id: 'cpu' as const, name: '基础运行环境', requirement: '必需', description: environment.group === 'speech' ? 'CPU 语音引擎、音频工具与检测文件' : 'CPU 文本引擎',
      items: baseItems, plan: basePlan, installed: baseComponents.filter(item => item.installed || completedIds.has(item.id)).length, available: true },
    { id: 'gpu' as const, name: 'GPU 加速支持', requirement: '可选', description: gpuDescription,
      items: gpuItems, plan: gpuPlan, installed: gpuItems.filter(item => item.action === 'reuse' || completedIds.has(item.id)).length, available: canInstallGpu }
  ]
  return <div className={styles.environment} data-runtime-group={environment.group} aria-label={`${groupName}运行环境`}>
    <div className={styles.environmentHeading}>
      <strong>运行环境</strong>
      <span className={styles.note}>{supported ? '先安装基础运行环境，再下载模型；GPU 加速支持可选。' : '当前平台仅支持管理模型文件。'}</span>
    </div>
    <div className={styles.runtimeScroll} role="region" aria-label={`${groupName}运行环境安装，可横向滚动`} tabIndex={0}>
      <table className={styles.runtimeTable} aria-label={`${groupName}运行环境安装`}>
        <colgroup><col className={styles.runtimeNameColumn} /><col className={styles.runtimeStateColumn} /><col className={styles.runtimeSizeColumn} /><col className={styles.runtimeActionColumn} /></colgroup>
        <thead className={styles.componentHead}><tr>{['支持项', '安装状态', '文件大小', '操作'].map(label => <th scope="col" className={styles.runtimeCell} key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => {
          const ids = new Set(row.items.map(item => item.id))
          const working = !!active && ids.has(active.itemId)
          const queued = !!active && active.plan.items.some(item => ids.has(item.id) && !completedIds.has(item.id))
          const installed = row.items.length > 0 && row.installed === row.items.length
          const partial = row.installed > 0 || environment.components.some(item => item.hasFiles && (row.id === 'cpu' ? baseIds.has(item.id) : !baseIds.has(item.id)))
            || row.items.some(item => item.action === 'verify' || item.action === 'download' && item.downloadBytes < item.bytes)
          const label = !supported ? '平台不支持' : checking ? '正在检查' : working ? active.phase === 'checking' ? '正在校验' : active.phase === 'installing' ? '正在安装' : '正在下载'
            : queued ? '等待安装' : installed ? '已安装' : partial ? '部分安装' : row.id === 'gpu' && gpu.state === 'platform' ? '无需安装' : '未安装'
          const action = installed ? '检查与修复' : partial ? '继续安装' : row.id === 'cpu' ? '安装运行环境' : '安装 GPU 加速支持'
          const plan = active && active.plan.items.some(item => ids.has(item.id)) ? active.plan : row.plan
          const plannedIds = new Set(plan.items.map(item => item.id))
          const additionalIds = new Set(row.plan.items.filter(item => !environment.components.some(component => component.id === item.id)).map(item => item.id))
          const components = allComponents.filter(component => row.id === 'cpu' ? baseIds.has(component.id)
            : component.group === environment.group && !baseIds.has(component.id) && (row.available && plannedIds.has(component.id) || hasFiles(component))
              || row.available && additionalIds.has(component.id))
          const removable = components.filter(component => component.group === environment.group && hasFiles(component))
          const expandable = components.length > 0 && (supported && row.available || removable.length > 0)
          const open = expandable && expanded[row.id]
          const heading = <><strong className={styles.runtimeName}>{row.name}</strong><SettingsStatusPill status="muted">{row.requirement}</SettingsStatusPill></>
          const content = <span className={styles.runtimeIdentity}>
            {expandable ? <button type="button" className={styles.runtimeToggle}
              aria-label={`${groupName}${row.name}组件清单`} aria-expanded={open} aria-controls={`${detailId}-${row.id}`}
              onClick={() => setExpanded(value => ({ ...value, [row.id]: !value[row.id] }))}>
              {open ? <ChevronDown {...UI_ICON_SM} /> : <ChevronRight {...UI_ICON_SM} />}{heading}
            </button> : <span className={styles.tags}>{heading}</span>}
            <span className={`${styles.note}${expandable ? ` ${styles.runtimeDescription}` : ''}`}>{row.description}</span>
          </span>
          return <Fragment key={row.id}><tr className={styles.runtimeRow} data-runtime-target={row.id}>
            <th scope="row" className={styles.runtimeCell}>{content}</th>
            <td className={styles.runtimeCell} aria-live="polite"><SettingsStatusPill status={working || checking || queued ? 'info' : supported && installed ? 'success' : 'muted'}>{label}</SettingsStatusPill></td>
            <td className={styles.runtimeCell}><div className={styles.runtimeIdentity}>
              <span>{row.items.some(item => !item.bytes) ? '—' : fileSize(row.items.reduce((sum, item) => sum + item.bytes, 0))}</span>
            </div></td>
            <td className={styles.runtimeCell}><div className={styles.runtimeActions}>{row.available && supported ? <Button size="sm" className={styles.runtimeAction} busy={working && state.downloadKind === 'acceleration'} disabled={disabled || checking}
              aria-label={`${groupName}${row.id === 'gpu' ? ' GPU 加速支持' : '基础运行环境'}：${action}`}
              onClick={() => void execute({ action: 'prepare-runtime', group: environment.group, target: row.id })}>{action}</Button> : <span className={styles.note}>{!supported ? '不支持安装' : gpu.state === 'disabled' ? '仅 CPU 模式' : gpu.state === 'platform' ? '无需安装' : missingDevice ? '请重新选择显卡' : '暂无可用显卡'}</span>}
              {removable.length > 0 && <IconButton size="control" tone="danger" icon={<Trash2 {...UI_ICON_SM} />}
                label={`删除${groupName}${row.name}`} disabled={disabled || checking}
                onClick={() => requestDelete(`${groupName}${row.name}`, row.id)} />}
            </div></td>
          </tr>
          {open && <tr className={styles.runtimeDetailsRow} data-runtime-details={row.id}><td colSpan={4} className={styles.runtimeDetailsCell}>
            <div id={`${detailId}-${row.id}`} role="region" aria-label={`${groupName}${row.name}组件清单`} className={styles.preparationDetails}>
              <p className={styles.note}>{row.id === 'gpu' ? '列出当前加速方式所需组件及已安装的其他 GPU 组件；缺少的基础环境会一起安装。实际 GPU 验证结果见下方精度行。'
                : `${environment.group === 'speech' ? '所有语音精度' : 'Qwen3、HY-MT2 的所有精度'}使用以下组件；安装完成后，当前选用精度会自动验证。`}</p>
              {components.length > 0 && <div className={styles.componentScroll} role="region" aria-label={`${groupName}${row.name}组件，可横向滚动`} tabIndex={0}>
                <table className={styles.componentTable} aria-label={`${groupName}${row.name}组件`}>
                  <thead className={styles.componentHead}><tr>{['组件', '后端', '安装状态', '文件大小', '版本', '来源'].map(title => <th className={styles.componentCell} scope="col" key={title}>{title}</th>)}</tr></thead>
                  <tbody>{components.map(component => {
                    const installed = component.installed || completedIds.has(component.id)
                    return <tr className={styles.componentRow} key={component.id}>
                      <th className={styles.componentCell} scope="row">{component.name}</th><td className={styles.componentCell}>{component.backend === 'common' ? '通用' : component.backend.toUpperCase()}</td>
                      <td className={styles.componentCell}><SettingsStatusPill status={installed ? 'success' : 'muted'}>{installed ? '已安装' : component.hasFiles ? '部分文件' : '未安装'}</SettingsStatusPill></td>
                      <td className={styles.componentCell}>{fileSize(component.bytes)}</td>
                      <td className={styles.componentCell}>{component.version}</td><td className={styles.componentCell}>{component.delivery === 'bundled' ? '应用内置' : sourceName(component.source)}</td>
                    </tr>
                  })}</tbody>
                </table>
              </div>}
            </div>
          </td></tr>}
          </Fragment>
        })}</tbody>
      </table>
    </div>
    {active && !state.activeVariant && active.plan.items.some(item => environment.components.some(component => component.id === item.id)) && <div className={styles.environmentProgress} role="status">
      <span>{preparationProgressLabel(state)}</span>
      <progress aria-label={`${groupName}运行环境安装进度`} max={state.downloadTotal || 1} value={state.downloadBytes} />
      <Button size="sm" onClick={() => void execute({ action: 'cancel-download' })}>暂停安装</Button>
    </div>}
    {failure && failureGroup(failure) === environment.group && !state.operation && <LocalModelOperationFeedback failure={failure} disabled={disabled} execute={execute} details={requestError} />}
    {deleting && <Modal title={blocked ? '请先删除模型文件' : '删除运行环境'} confirmText="删除" danger
      confirmDisabled={disabled || checking || blocked || deletingComponents.length === 0}
      actions={blocked ? <><Button onClick={() => setDeleting(null)}>关闭</Button><Button variant="primary" onClick={() => { setDeleting(null); requestFiles() }}>查看相关文件</Button></> : undefined}
      onCancel={() => setDeleting(null)} onConfirm={async () => {
        if (blocked || disabled || checking) return
        if (await execute({ action: 'delete-runtime', group: environment.group, target: deleting.target })) setDeleting(null)
        else setDeleteError(true)
      }}>
      <p>{deleting.name}</p>
      {blocked ? <><p role="alert">请先删除以下{groupName}模型文件，再删除基础运行环境：</p>
        <ul>{remainingModels.map(({ model, variant }) => <li key={variant.id}><Button variant="ghost" size="sm" onClick={() => { setDeleting(null); requestFiles(variant.id) }}>
          {model.name} · {variant.precision} · {variant.publisher} · {variant.installed ? '已下载' : '部分文件'}
        </Button></li>)}</ul></>
        : <><p>将删除以下组件的安装文件和未完成下载：</p>
          <ul>{deletingComponents.map(component => <li key={component.id}>{component.name} · {component.backend.toUpperCase()}</li>)}</ul>
          <p>{deletingBase ? `删除后，下载或导入${groupName}模型前需要重新安装基础运行环境。`
            : '删除后会重新检查依赖和精度状态；基础环境可用时自动使用 CPU。'}</p></>}
      {deleteError && <p role="alert" className={styles.fullError}>{failure?.message ?? '删除失败，请查看页面错误详情后重试。'}</p>}
    </Modal>}
  </div>
}
