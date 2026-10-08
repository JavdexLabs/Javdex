import { useEffect, useId, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AudioLines, ChevronDown, ChevronRight, TextCursorInput } from 'lucide-react'
import type { LocalModelDownloadSource, LocalModelCommand, LocalModelId, LocalModelSnapshot, LocalModelVariantView, LocalModelView } from '@shared/desktop/localModels'
import Button from '../Button'
import FloatingLayer from '../FloatingLayer'
import Modal from '../Modal'
import SelectControl from '../SelectControl'
import { DetailMenuItem } from '../DetailMenu'
import { UI_ICON_SM } from '../iconDefaults'
import { settingsPath } from '../../settings/settingsRoutes'
import { useLocalModels } from './useLocalModels'
import styles from './LocalModelsPanel.module.css'

const readinessLabel = { ready: '可运行', 'missing-model': '未安装', 'missing-runtime': '需补齐运行依赖', unsupported: '仅管理文件' }
type Execute = (command: LocalModelCommand) => Promise<boolean>
interface ModelProps {
  model: LocalModelView
  state: LocalModelSnapshot
  busy: boolean
  execute: Execute
  requestDelete: (model: LocalModelView, variant: LocalModelVariantView) => void
}

function VariantActions({ model, variant, state, busy, execute, requestDelete }: ModelProps & { variant: LocalModelVariantView }): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const working = busy || state.operation !== null
  const sharedRuntimeInUse = state.models.some(item => item.id !== 'kotoba' && item.inUse)
  const repairing = state.operation === 'download' && state.activeVariant === variant.id
  function run(action: 'copy-download-url' | 'import' | 'export'): void {
    setOpen(false)
    void execute({ action, model: model.id, variant: variant.id })
  }
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])
  return <div className={styles.variantActions}>
    <Button size="sm" variant={variant.installed ? 'default' : 'primary'} className={styles.downloadButton} aria-busy={repairing}
      disabled={working || model.inUse || (model.id !== 'kotoba' && sharedRuntimeInUse)}
      onClick={() => void execute({ action: 'download', model: model.id, variant: variant.id })}>
      {variant.installed ? '校验与修复' : '下载模型'}
    </Button>
    <Button ref={anchorRef} size="sm" className={styles.moreButton} aria-label={`${model.name} ${variant.precision} ${variant.publisher} 更多操作`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}>
      更多<ChevronDown {...UI_ICON_SM} />
    </Button>
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
        <DetailMenuItem disabled={busy} onClick={() => run('copy-download-url')}>复制下载地址</DetailMenuItem>
        <DetailMenuItem disabled={working || variant.inUse} onClick={() => run('import')}>导入模型文件</DetailMenuItem>
        <DetailMenuItem disabled={working || !variant.installed} onClick={() => run('export')}>导出模型文件</DetailMenuItem>
        <DetailMenuItem danger disabled={working || variant.inUse || !variant.installed || variant.references.length > 0}
          onClick={() => { setOpen(false); requestDelete(model, variant) }}>删除此精度</DetailMenuItem>
      </div>
    </FloatingLayer>
  </div>
}

function ModelFamily({ model, state, busy, execute, requestDelete, expanded, onToggle, installedOnly, targetVariant }: ModelProps & {
  expanded: boolean; onToggle: () => void; installedOnly: boolean; targetVariant?: string | null
}): JSX.Element {
  const [allPrecisions, setAllPrecisions] = useState(false)
  const tableId = useId()
  const targetRef = useRef<HTMLDivElement>(null)
  const installed = model.variants.filter(variant => variant.installed)
  const ready = installed.filter(variant => variant.ready)
  const references = [...new Set(model.variants.flatMap(variant => variant.references))]
  const variants = model.variants.filter(variant => variant.id === targetVariant
    || (installedOnly ? variant.installed : allPrecisions || variant.installed || variant.recommended))
  useEffect(() => {
    if (expanded && targetVariant) targetRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [expanded, targetVariant])
  const status = model.inUse ? '正在使用' : !installed.length ? '未安装' : !state.supported ? '此平台仅管理文件'
    : ready.length ? `${ready.length} 个精度可运行` : '需补齐运行依赖'
  return <article className={styles.family} aria-label={`${model.name} 模型文件`}>
    <div className={styles.familyHeader}>
      <div className={styles.identity}><h4>{model.name}</h4><span className={styles.note}>{model.purpose} · {model.variants.length} 个精度与发布者组合</span></div>
      <div className={styles.familyState}><span>已安装 {installed.length} / {model.variants.length} · {status}</span>
        <span className={styles.note}>{references.length ? `用于 ${references.join('、')}` : '未被用途引用'}</span></div>
      <Button size="sm" className={styles.manageButton} aria-label={`${model.name} 管理精度`} aria-expanded={expanded} aria-controls={tableId} onClick={onToggle}>
        管理精度{expanded ? <ChevronDown {...UI_ICON_SM} /> : <ChevronRight {...UI_ICON_SM} />}
      </Button>
    </div>
    {expanded && <div className={styles.familyDetails} id={tableId}>
      <div className={styles.variantToolbar}><p className={styles.note}>下载或导入只管理文件，模型用途在“用途配置”中选择。</p>
        {!installedOnly && <SelectControl aria-label={`${model.name} 精度范围`} value={allPrecisions ? 'all' : 'recommended'}
          onChange={event => setAllPrecisions(event.target.value === 'all')}>
          <option value="recommended">推荐与已安装</option><option value="all">全部精度</option>
        </SelectControl>}</div>
      <div className={styles.table} role="table" aria-label={`${model.name} 精度列表`}>
        <div className={styles.tableHead} role="row"><span role="columnheader">精度</span><span role="columnheader">发布者</span>
          <span role="columnheader">文件大小</span><span role="columnheader">状态与用途</span><span role="columnheader">操作</span></div>
        <div className={styles.tableBody} role="rowgroup">{variants.map(variant => <div key={variant.id} role="row" data-variant={variant.id} data-target={variant.id === targetVariant || undefined}
          ref={variant.id === targetVariant ? targetRef : undefined} className={`${styles.variantRow}${variant.id === targetVariant ? ` ${styles.targetRow}` : ''}`}>
          <div role="cell" className={styles.precision}><strong>{variant.precision}</strong><span className={styles.note}>{variant.format}{variant.recommended ? ' · 推荐' : ''}</span></div>
          <span role="cell" className={styles.publisher}>{variant.publisher}</span>
          <span role="cell" className={styles.size}>{(variant.bytes / 1e9).toFixed(2)} GB</span>
          <div role="cell" className={styles.variantState}><span className={variant.ready ? styles.ready : undefined}>
            {state.operation === 'download' && state.activeVariant === variant.id ? '正在下载 / 校验' : variant.inUse ? '正在使用' : readinessLabel[variant.readiness]}</span>
            <span className={styles.note}>{variant.references.length ? variant.references.join('、') : '未被用途引用'}</span></div>
          <div role="cell"><VariantActions {...{ model, variant, state, busy, execute, requestDelete }} /></div>
        </div>)}</div>
      </div>
      <details className={styles.details}><summary>来源、校验与适用范围</summary><div className={styles.detailBody}>
        <p className={styles.note}>固定版本：{model.version}。下载及导入均核验对应精度和发布者的 SHA-256；外部文件会复制到保存目录，原文件保留。导出不包含运行依赖和缓存，分发请遵守上游许可证。文件大小不是运行内存需求。</p>
        {[...new Set(model.variants.map(variant => variant.source))].map(source => <p key={source} className={styles.path}>{source}</p>)}
        {references.length > 0 && <p className={styles.note}>用途引用：{references.join('、')}。修改用途后才可删除正在引用的精度。</p>}
        {model.id === 'kotoba' && <p className={styles.note}>日语语音转写使用 Kotoba v2.0；v2.2 的角色区分及标点增强未接入。识别文本的中文翻译由单独的文本模型负责。</p>}
        {model.id === 'hy-mt2-7b' && <p className={styles.note}>腾讯官方 GGUF，Apache-2.0。当前目录只收录已有完整校验信息的精度。</p>}
        {model.id === 'index-translate-9b' && <p className={styles.note}>Index-Translate 9B 只用于文本翻译，不接收语音、图片或视频；许可证以官方模型仓库为准。</p>}
      </div></details>
    </div>}
  </article>
}

export default function LocalModelsPanel(): JSX.Element {
  const { state, busy, feedback, error, snapshotError, execute } = useLocalModels()
  const location = useLocation()
  const navigate = useNavigate()
  const query = new URLSearchParams(location.search)
  const targetModel = query.get('model') as LocalModelId | null
  const targetVariant = query.get('variant')
  const [expanded, setExpanded] = useState<Partial<Record<LocalModelId, boolean>>>({})
  const [installedOnly, setInstalledOnly] = useState(false)
  const [showError, setShowError] = useState(false)
  const [deleting, setDeleting] = useState<{ model: LocalModelView; variant: LocalModelVariantView } | null>(null)
  useEffect(() => {
    if (!targetModel) return
    setInstalledOnly(false)
    setExpanded(value => ({ ...value, [targetModel]: true }))
  }, [targetModel, targetVariant])
  if (!state) return <p role="status">{error || '正在读取本地模型…'}</p>
  const working = busy || state.operation !== null
  const anyInUse = state.models.some(model => model.inUse)
  const currentError = error || snapshotError
  const summary = state.operation === 'download' ? `${feedback === '下载地址已复制' ? '下载地址已复制 · ' : ''}${state.downloadLabel ?? '模型'} · ${Math.floor(state.downloadBytes / 1048576)} / ${Math.ceil(state.downloadTotal / 1048576)} MB`
    : state.operation === 'import' ? '正在复制并校验模型文件…'
      : state.operation === 'relocate' ? '正在迁移并校验模型，原位置在完成前保持有效'
        : state.operation === 'export' ? '正在复制并校验导出模型'
          : state.operation === 'delete' ? '正在删除模型精度'
            : busy ? '正在处理，保留上次结果' : currentError ? '操作失败，请查看错误详情'
              : feedback || '下载或导入后，在用途配置中选择要使用的模型与精度'
  function returnToUsage(): void {
    const next = new URLSearchParams(location.search)
    next.delete('model'); next.delete('variant')
    navigate({ pathname: settingsPath('models', 'usage'), search: next.toString(), hash: '#ai-subtitles' })
  }
  const deletingVariant = deleting && state.models.find(model => model.id === deleting.model.id)?.variants.find(variant => variant.id === deleting.variant.id)
  return <div className={styles.root}>
    <section className={styles.card} aria-label="模型文件管理">
      <div className={styles.catalogHeading}><h3 className={styles.title}>模型文件</h3><div className={styles.headingActions}>
        {targetModel && <Button size="sm" onClick={returnToUsage}>返回用途配置</Button>}
        <SelectControl aria-label="模型文件范围" value={installedOnly ? 'installed' : 'all'} onChange={event => setInstalledOnly(event.target.value === 'installed')}>
          <option value="all">全部模型</option><option value="installed">已安装模型</option>
        </SelectControl>
      </div></div>
      <details className={styles.details}><summary>下载、保存位置与运行环境</summary><div className={styles.detailBody}>
        <label className={styles.sourceField}>下载来源<SelectControl aria-label="模型下载来源" value={state.downloadSource} disabled={working}
          onChange={event => void execute({ action: 'download-source', source: event.target.value as LocalModelDownloadSource })}>
          <option value="official">官方源</option><option value="hf-mirror">HF-Mirror 镜像</option>
        </SelectControl></label>
        <p className={styles.note}>选择后立即保存，用于后续模型下载与修复。HF-Mirror 是第三方镜像，仍按固定版本校验文件；GitHub 运行依赖使用原下载地址。</p>
        <p className={styles.path}>保存位置：{state.directory}</p>
        <div className={styles.actions}><Button size="sm" disabled={working || anyInUse} onClick={() => void execute({ action: 'choose-location' })}>更改并迁移</Button>
          <Button size="sm" disabled={working || anyInUse || state.directory === state.defaultDirectory} onClick={() => void execute({ action: 'reset-location' })}>恢复默认位置</Button></div>
        <p className={styles.note}>迁移会复制并校验现有模型，成功后切换目录并清理旧副本。模型使用中须先停止字幕或等待文本翻译完成。</p>
        <p className={styles.note}>语音识别依赖 whisper、FFmpeg 与语音检测文件；文本模型共用 llama.cpp 运行依赖。导入只复制模型文件，缺少依赖时使用“校验与修复”补齐。</p>
        <p className={styles.note}>支持 Windows x64、macOS 13.3+ arm64/x64，以及满足运行依赖要求的 Linux arm64/x64（glibc 2.38+、GCC 14 与 xz）。其他平台仍可管理模型文件，下载不代表能在此平台运行。</p>
      </div></details>
      <div className={styles.feedback} aria-busy={working}>
        <span className={styles.summary} role={currentError && !working ? 'alert' : 'status'}>{summary}</span>
        <progress className={styles.progress} data-visible={state.operation === 'download'} aria-label="模型下载进度" aria-hidden={state.operation !== 'download'}
          max={state.downloadTotal || 1} value={state.downloadBytes} />
        <Button size="sm" className={styles.errorButton} data-visible={!!currentError} disabled={!currentError} aria-hidden={!currentError}
          tabIndex={currentError ? 0 : -1} onClick={() => setShowError(true)}>错误详情</Button>
        <Button size="sm" className={styles.cancelButton} disabled={busy || state.operation !== 'download'} onClick={() => void execute({ action: 'cancel-download' })}>取消下载</Button>
      </div>
    </section>
    {([{ id: 'speech', title: '语音输入 → 文本', icon: <AudioLines {...UI_ICON_SM} />, models: state.models.filter(model => model.id === 'kotoba') },
      { id: 'text', title: '文本输入 → 文本', icon: <TextCursorInput {...UI_ICON_SM} />, models: state.models.filter(model => model.id !== 'kotoba') }]).map(group => {
      const models = group.models.filter(model => !installedOnly || model.variants.some(variant => variant.installed) || model.id === targetModel)
      return <section className={styles.card} key={group.id} aria-label={group.title}><h3 className={styles.title}>{group.icon}{group.title}</h3>
        {models.length ? models.map(model => <ModelFamily key={model.id} {...{ model, state, busy, execute, installedOnly }}
          expanded={!!expanded[model.id]} targetVariant={model.id === targetModel ? targetVariant : undefined}
          onToggle={() => setExpanded(value => ({ ...value, [model.id]: !value[model.id] }))} requestDelete={(family, variant) => setDeleting({ model: family, variant })} />)
          : <p className={styles.note}>尚未下载此模态的模型精度，可切换到“全部模型”后下载或导入。</p>}
      </section>
    })}
    <p className={styles.note}>模型下载、导入与删除均不会自动切换用途。字幕识别、字幕翻译和文本翻译在“用途配置”中分别设置。</p>
    {showError && <Modal title="本地模型操作失败" hideActions onCancel={() => setShowError(false)}><p className={styles.fullError}>{currentError || '错误已解除。'}</p></Modal>}
    {deleting && <Modal title="删除模型精度" confirmText="删除此精度" danger busy={busy}
      confirmDisabled={state.operation !== null || !deletingVariant || deletingVariant.inUse || deletingVariant.references.length > 0}
      onCancel={() => setDeleting(null)} onConfirm={async () => {
        if (await execute({ action: 'delete', model: deleting.model.id, variant: deleting.variant.id })) setDeleting(null)
      }}><p className={styles.path}>{deleting.model.name} · {deleting.variant.precision} · {deleting.variant.publisher}</p>
      <p>只删除此精度的模型文件，保留运行依赖与其他精度。重新使用时需要再次下载或导入。</p>
      {deletingVariant?.references.length ? <p role="alert">此精度已被用途引用，请先在用途配置中改用其他精度。</p> : null}
      {currentError && <p role="alert" className={styles.fullError}>{currentError}</p>}
    </Modal>}
  </div>
}
