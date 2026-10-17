import { useEffect, useId, useRef, useState } from 'react'
import { Ellipsis, Folder, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import type { LocalModelCommand, LocalModelDownloadSource, LocalModelSnapshot } from '@shared/desktop/localModels'
import Button from '../Button'
import IconButton from '../IconButton'
import FloatingLayer from '../FloatingLayer'
import SelectControl from '../SelectControl'
import { DetailMenuItem } from '../DetailMenu'
import { UI_ICON_SM } from '../iconDefaults'
import { useToast } from '../Toast'
import { SettingsCard, SettingsDisclosure, SettingsRow } from './SettingsPrimitives'
import { preparationSize } from './LocalRuntimeEnvironment'
import styles from './LocalModelStoragePanel.module.css'

interface Props {
  state: LocalModelSnapshot
  busy: boolean
  execute: (command: LocalModelCommand) => Promise<boolean>
  error: string | null
  requestError: () => void
}

const entries = [
  { id: 'models', label: '模型文件' },
  { id: 'runtimes', label: '运行环境' },
  { id: 'downloads', label: '未完成下载', action: 'clean-downloads', actionLabel: '清理未完成下载' },
  { id: 'staging', label: '安装暂存' },
  { id: 'cache', label: '推理缓存', action: 'clear-cache', actionLabel: '清理推理缓存' }
] as const

export default function LocalModelStoragePanel({ state, busy, execute, error, requestError }: Props): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState<LocalModelCommand['action'] | null>(null)
  const requestBusy = useRef(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const toast = useToast()
  const working = busy || state.operation !== null
  const anyInUse = state.models.some(model => model.inUse)
  const blocked = working || anyInUse
  const total = state.storage && entries.reduce((sum, item) => sum + state.storage![item.id].bytes, 0)
  async function run(command: LocalModelCommand): Promise<void> {
    if (requestBusy.current) return
    requestBusy.current = true
    setPending(command.action)
    try {
      if (!await execute(command)) return
      if (command.action === 'clean-downloads') toast.show('未完成下载已清理', 'success')
      else if (command.action === 'clear-cache') toast.show('推理缓存已清理', 'success')
      else if (command.action === 'refresh-storage') toast.show('存储统计已更新')
    } finally { requestBusy.current = false; setPending(null) }
  }
  useEffect(() => {
    if (!menuOpen) return
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [menuOpen])
  return <SettingsCard title="存储与维护" hint="管理下载来源、存储位置与临时文件。" aria-label="存储与维护"
    className={styles.root} headerClassName={styles.storageHeader} actions={<div className={styles.headerActions}>
      <span className={styles.total} title={state.storage ? `统计时间：${new Date(state.storage.checkedAt).toLocaleString()}；包含安装目录内的说明与校验文件` : '尚未获取文件统计，可刷新统计'}>
        <span>合计占用</span><strong className={styles.totalValue}>{total === undefined ? '—' : preparationSize(total)}</strong>
      </span>
      <IconButton size="control" icon={<RefreshCw {...UI_ICON_SM} />} label="刷新统计" disabled={working}
        aria-busy={pending === 'refresh-storage'} onClick={() => void run({ action: 'refresh-storage' })} />
    </div>}>
    <div className={styles.locationRow}>
      <span className={styles.label}>保存位置</span>
      <div className={styles.directory} title={state.directory}><Folder {...UI_ICON_SM} className={styles.directoryIcon} /><span className={styles.directoryPath}>{state.directory}</span></div>
      <div className={styles.locationActions}>
        <IconButton size="control" icon={<FolderOpen {...UI_ICON_SM} />} label="打开保存目录" disabled={busy}
          onClick={() => void run({ action: 'open-location' })} />
        <Button size="sm" disabled={blocked} title={anyInUse ? '模型使用中，请等待任务结束' : undefined}
          busy={pending === 'choose-location'} onClick={() => void run({ action: 'choose-location' })}>更改并迁移</Button>
        <IconButton ref={anchorRef} size="control" icon={<Ellipsis {...UI_ICON_SM} />} label="保存位置更多操作"
          aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen(value => !value)} />
        <FloatingLayer open={menuOpen} anchorRef={anchorRef} role="menu" side="bottom" align="end" id={menuId}
          className={styles.menu} ariaLabel="保存位置操作" onClose={() => setMenuOpen(false)}>
          <div ref={menuRef} onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== anchorRef.current) setMenuOpen(false)
          }} onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            event.currentTarget.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
          }}>
            <DetailMenuItem disabled={blocked || state.directory === state.defaultDirectory}
              title={anyInUse ? '模型使用中，请等待任务结束' : state.directory === state.defaultDirectory ? '已使用默认保存位置' : undefined}
              onClick={() => {
                anchorRef.current?.focus(); setMenuOpen(false)
                void run({ action: 'reset-location' })
              }}>恢复默认位置</DetailMenuItem>
          </div>
        </FloatingLayer>
      </div>
    </div>
    <div className={styles.tableScroll} role="region" aria-label="本地文件占用，可横向滚动" tabIndex={0}>
      <table className={styles.table} aria-label="本地文件占用">
        <colgroup><col className={styles.categoryColumn} /><col className={styles.sizeColumn} /><col className={styles.countColumn} /><col /></colgroup>
        <thead><tr>{['文件分类', '文件大小', '文件数', '操作'].map(label => <th key={label} className={`${styles.tableCell} ${styles.tableHead}`} scope="col">{label}</th>)}</tr></thead>
        <tbody>{entries.map((item, index) => {
          const usage = state.storage?.[item.id]
          const cellClass = `${styles.tableCell}${index === entries.length - 1 ? ` ${styles.lastCell}` : ''}`
          return <tr key={item.id} className={usage?.bytes === 0 ? styles.empty : undefined}>
            <th scope="row" className={cellClass}>{item.label}</th><td className={`${cellClass} ${styles.numeric}`}>{usage ? preparationSize(usage.bytes) : '—'}</td>
            <td className={`${cellClass} ${styles.numeric}`}>{usage ? `${usage.files} 个文件` : '—'}</td>
            <td className={cellClass}>{'action' in item ? <div className={styles.cleanupAction}>
              <Button size="sm" variant="ghost" aria-label={item.actionLabel} disabled={blocked || usage?.files === 0}
                busy={pending === item.action} title={anyInUse ? '模型使用中，请等待任务结束' : usage?.files === 0 ? '没有可清理的文件' : item.actionLabel}
                onClick={() => void run({ action: item.action })}><span className={styles.cleanLabel}><Trash2 {...UI_ICON_SM} />清理</span></Button>
            </div> : <span className={styles.note}>{item.id === 'staging' ? '过期自动清理' : '—'}</span>}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {error && <div className={styles.failure} role="alert">
      <span>操作失败，请查看错误详情</span><Button size="sm" variant="ghost" onClick={requestError}>错误详情</Button>
    </div>}
    <div className={styles.sourceRow}><SettingsRow title="模型下载来源" description="用于模型权重与语音检测文件；GitHub 运行组件使用原来源。">
      <SelectControl aria-label="模型下载来源" value={state.downloadSource} disabled={working}
        onChange={event => void execute({ action: 'download-source', source: event.target.value as LocalModelDownloadSource })}>
        <option value="official">官方源</option><option value="hf-mirror">HF-Mirror 镜像</option>
      </SelectControl>
    </SettingsRow></div>
    <SettingsDisclosure title="下载校验与目录迁移说明">
      <p>HF-Mirror 是第三方镜像，仍按固定版本校验文件；GitHub 运行依赖使用原下载地址。</p>
      <p>模型按系列、发布者、固定版本与精度保存，运行环境按引擎版本与平台保存。迁移会校验模型、运行环境与续传文件，成功后切换并清理旧副本；缓存独立保存，不随模型迁移。模型使用中请先停止调用，再迁移。</p>
    </SettingsDisclosure>
    <SettingsDisclosure title="自动清理规则与运行要求">
      <p>未完成下载保留 7 天以便续传，安装暂存超过 1 天自动清理。清理不删除已安装模型与运行环境。</p>
      <p>推理缓存包含可复用字幕与任务临时文件，清理后需要重新生成。模型使用中暂停清理与目录迁移。</p>
      <p>语音识别依赖 whisper、FFmpeg 与语音检测文件；文本模型使用 llama.cpp 运行环境。下载或导入前需先安装基础运行环境，GPU 加速支持可选。</p>
      <p>支持 Windows x64、macOS 13.3+ arm64/x64，以及满足运行依赖要求的 Linux arm64/x64（glibc 2.38+、GCC 14 与 xz）。其他平台仍可管理模型文件，下载不代表能在此平台运行。</p>
    </SettingsDisclosure>
  </SettingsCard>
}
