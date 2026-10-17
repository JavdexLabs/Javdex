import { CheckCircle2, Circle } from 'lucide-react'
import type { LocalExecutionStatus, LocalModelCommand, LocalModelSnapshot, LocalModelVariantView, LocalModelView } from '@shared/desktop/localModels'
import Button from '../Button'
import { SettingsStatusPill } from './SettingsPrimitives'
import styles from './LocalModelsPanel.module.css'

export function executionLabel(value?: LocalExecutionStatus): string {
  if (!value || value.backend === 'idle') return '等待推理'
  return value.backend === 'cpu' ? 'CPU' : value.backend === 'metal' ? 'Metal' : value.device ?? value.backend.toUpperCase()
}
const purposeLabels: Record<string, string> = {
  'AI 字幕 · 语音识别': '字幕识别', 'AI 字幕 · 文本翻译': '字幕翻译'
}

export default function LocalModelStatus({ model, variant, state, busy, execute }: {
  model: LocalModelView; variant: LocalModelVariantView; state: LocalModelSnapshot; busy: boolean
  execute: (command: LocalModelCommand) => Promise<boolean>
}) {
  const check = variant.validation, backend = check?.execution?.backend
  const downloading = state.operation === 'download' && state.activeVariant === variant.id
  const reason = check?.message ?? check?.execution?.reason
  const gpuFallback = backend === 'cpu' && !!reason && state.acceleration?.policy.mode !== 'cpu'
    && (!!state.acceleration?.devices.length || state.acceleration?.policy.mode === 'gpu')
  const optionalGpuMissing = state.acceleration?.policy.mode === 'auto'
    && state.environments?.find(item => item.group === (model.id === 'kotoba' ? 'speech' : 'text'))?.gpu.state === 'missing'
  const repairGpu = gpuFallback && /运行库|未启用|启动失败|试运行失败|推理失败/.test(reason ?? '')
  const fallbackSummary = /运行库/.test(reason ?? '') ? '加速运行支持未就绪'
    : /指定显卡/.test(reason ?? '') ? '指定显卡不可用'
      : /显存|内存/.test(reason ?? '') ? '显存不足，已验证 CPU' : '显卡试运行未通过，CPU 可用'
  const runtimeReady = variant.runtimeReady ?? variant.ready
  const blocked = busy || state.operation !== null || model.inUse || (model.id !== 'kotoba' && state.models.some(item => item.id !== 'kotoba' && item.inUse))
  const label = !state.supported ? '仅管理文件' : !variant.installed ? '待下载' : !runtimeReady ? '待安装运行环境'
    : check?.state === 'checking' ? '正在验证' : check?.state === 'waiting' ? '等待验证'
      : check?.state === 'failed' ? '验证失败' : check?.state === 'passed'
        ? gpuFallback && !optionalGpuMissing ? 'CPU 可用 · 显卡未启用' : backend === 'cpu' ? 'CPU 已验证' : backend === 'metal' ? 'Metal 已验证' : 'GPU 已验证'
        : variant.references.length ? '等待验证' : '未验证'
  const tone = check?.state === 'failed' || gpuFallback && !optionalGpuMissing ? styles.warning : check?.state === 'passed' ? styles.ready : ''
  return <>
    <td className={styles.cell}><div className={styles.statusCell}>
      <span className={styles.validationLabel}>{variant.installed && <CheckCircle2 size={14} className={styles.ready} aria-hidden="true" />}
        {downloading && state.downloadKind !== 'acceleration' ? '下载 / 校验中' : variant.installed ? '已下载' : variant.hasFiles ? '部分文件' : '未下载'}</span>
      <span className={styles.note}>{(variant.bytes / 1e9).toFixed(2)} GB</span>
      {!variant.installed && variant.hasFiles && !!variant.preparation && variant.preparation.downloadBytes < variant.bytes && <span className={styles.note}>
        已下载 {Math.min(100, Math.floor((1 - variant.preparation.downloadBytes / variant.bytes) * 100))}% · 可继续
      </span>}
    </div></td>
    <td className={styles.cell}><div className={styles.tags}>
      {variant.references.length ? variant.references.map(reference => <SettingsStatusPill key={reference} status="info">{purposeLabels[reference] ?? reference}</SettingsStatusPill>) : <span className={styles.note}>—</span>}
    </div></td>
    <td className={styles.cell} aria-live="polite"><div className={styles.statusCell}>
      {variant.dependencies && (variant.references.length > 0 || (variant.installed && variant.dependencies.state !== 'ready')) && <span className={styles.note}>{variant.dependencies.state === 'checking' ? '正在检查依赖' : variant.dependencies.state === 'ready' ? '依赖检查通过'
        : variant.dependencies.state === 'cpu-fallback' ? optionalGpuMissing ? 'CPU 就绪 · GPU 可选' : 'CPU 就绪 · GPU 待安装' : variant.dependencies.state === 'unsupported' ? '仅管理文件' : '待安装运行环境'}</span>}
      <span className={`${styles.validationLabel} ${tone}`}>
        <Circle size={7} fill="currentColor" aria-hidden="true" />{label}
      </span>
      {check?.state === 'passed' && backend !== 'cpu' && check.execution?.device && <span className={styles.note}>{check.execution.device.replace(/^NVIDIA GeForce\s+/, '')}</span>}
      {gpuFallback && !repairGpu && <span className={styles.note}>{fallbackSummary}</span>}
      {check?.state === 'waiting' && <span className={styles.note}>{check.message ?? '空闲后自动验证'}</span>}
      {variant.installed && state.supported && !runtimeReady && <Button size="sm" variant="ghost" className={styles.inlineAction} disabled={blocked}
        onClick={() => void execute({ action: 'prepare-runtime', group: model.id === 'kotoba' ? 'speech' : 'text', target: 'cpu' })}>安装运行环境</Button>}
      {!check && variant.ready && !variant.references.length && <span className={styles.note}>选用后自动验证</span>}
      {repairGpu && !optionalGpuMissing && state.acceleration?.supported && <Button size="sm" variant="ghost" className={styles.inlineAction}
        disabled={busy || state.operation !== null || state.models.some(item => item.inUse)}
        onClick={() => void execute({ action: 'prepare-acceleration', model: model.id, variant: variant.id })}>修复并验证</Button>}
      {check?.state === 'failed' && <Button size="sm" variant="ghost" className={styles.inlineAction} disabled={blocked}
        onClick={() => void execute({ action: 'download', model: model.id, variant: variant.id })}>校验与修复</Button>}
    </div></td>
  </>
}
