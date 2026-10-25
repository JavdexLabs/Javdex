import { localModelGroup, type LocalAccelerationPolicy, type LocalGpuDevice, type LocalModelGroup, type LocalModelRef, type LocalPreparationPlan, type LocalRuntimeComponent } from '@shared/desktop/localModels'
import { aiRuntimeAssets, type AiRuntimeAsset, type AiRuntimeTarget } from './runtimeManifest'
import { runtimeSupportsMetal } from './runtimeDistributionAssets'
import { gpuRuntimeAssets } from './gpuManifest'
import { localModelVariant } from './modelCatalog'
import { audioCppAsset, AUDIOCPP_VERSION, QWEN_ALIGNER, qwenAsrSupported } from './qwenAsrManifest'

export interface RuntimeComponentDefinition {
  component: Omit<LocalRuntimeComponent, 'installed'>
  assetId: AiRuntimeAsset['id']
  asset?: AiRuntimeAsset
}
const baseIds = ['whisper', 'ffmpeg', 'vad', 'translator'] as const
const names = { whisper: '语音引擎', translator: '文本引擎', ffmpeg: '音频提取工具', vad: '语音检测模型', cuda: 'CUDA/cuBLAS 依赖' }
export function runtimeComponentDefinitions(target: AiRuntimeTarget): RuntimeComponentDefinition[] {
  const base = aiRuntimeAssets(target)
  const definition = (id: typeof baseIds[number] | 'cuda', backend: LocalRuntimeComponent['backend'], asset?: AiRuntimeAsset): RuntimeComponentDefinition => {
    return { assetId: id, asset, component: {
      id: `${id}-${backend}`, group: id === 'translator' || id === 'cuda' ? 'text' : 'speech',
      name: names[id], backend, delivery: 'download', bytes: asset?.bytes ?? 0,
      version: asset?.model?.family ?? (id === 'whisper' ? 'b5130' : id === 'ffmpeg' ? '8.1.3' : id === 'cuda' ? target.platform === 'linux' ? '12.8.1' : '12.4' : 'b11435'),
      source: asset?.url ?? ''
    } }
  }
  return [
    ...baseIds.map(id => definition(id, id === 'ffmpeg' || id === 'vad' ? 'common' : 'cpu', base.find(asset => asset.id === id))),
    ...(['cuda', 'vulkan'] as const).flatMap(backend => gpuRuntimeAssets(target, backend)
      .map(asset => definition(asset.id as 'whisper' | 'translator' | 'cuda', backend, asset))),
    ...(qwenAsrSupported(target) ? [...audioCppAsset(target), QWEN_ALIGNER, ...audioCppAsset(target, true), base.find(asset => asset.id === 'ffmpeg')!].map(asset => ({
      assetId: asset.id, asset, component: { id: asset.id === 'ffmpeg' ? 'ffmpeg-qwen-speech-common' : `${asset.id}-${asset.backend ?? (asset.archive ? 'cpu' : 'common')}`,
        group: 'qwen-speech' as const, name: asset.id === 'ffmpeg' ? '音频提取工具（共用）' : asset.label,
        backend: asset.id === 'ffmpeg' ? 'common' as const : asset.backend ?? (asset.archive ? 'cpu' as const : 'common' as const),
        delivery: 'download' as const, bytes: asset.bytes, version: asset.id === 'ffmpeg' ? '8.1.3' : asset.archive ? AUDIOCPP_VERSION : '0.6B Q8_0', source: asset.url }
    })) : [])
  ]
}

/** Match execution selection, including an installed alternative backend in automatic mode. */
export function runtimeBackend(group: LocalModelGroup, policy: LocalAccelerationPolicy, devices: LocalGpuDevice[], components: LocalRuntimeComponent[]): 'cuda' | 'vulkan' | undefined {
  if (policy.mode === 'cpu') return undefined
  if (group === 'qwen-speech') {
    return policy.mode === 'gpu' || devices.length > 0 ? 'vulkan' : undefined
  }
  devices = devices.filter(device => !device.audioCppOnly)
  const engine = group === 'speech' ? 'whisper' : 'translator'
  const ready = (device: LocalGpuDevice) => components.some(item => item.id === `${engine}-${device.backend}` && item.installed)
    && (device.backend !== 'cuda' || group === 'speech' || components.some(item => item.id === 'cuda-cuda' && item.installed))
  const device = policy.mode === 'gpu' ? devices.find(item => item.id === policy.device)
    : devices.find(item => item.backend === 'cuda' && ready(item)) ?? devices.find(ready) ?? devices[0]
  return device?.backend
}

export function preparationPlan(options: {
  groups: LocalModelGroup[]; refs?: LocalModelRef[]; components: LocalRuntimeComponent[]; policy: LocalAccelerationPolicy
  devices: LocalGpuDevice[]; target: AiRuntimeTarget; installed: (variant: string) => boolean
  resumed?: (id: string) => number; forceGpu?: boolean; supported: boolean
}): LocalPreparationPlan {
  const { groups, policy, devices, target, components } = options
  const items: LocalPreparationPlan['items'] = []
  let backend: LocalPreparationPlan['backend'] = policy.mode === 'auto' && groups.some(group => group !== 'qwen-speech' && runtimeSupportsMetal(target, group === 'speech' ? 'whisper' : 'translator')) ? 'metal' : 'cpu'
  for (const ref of options.refs ?? []) {
    const variant = localModelVariant(ref.model, ref.variant), installed = options.installed(variant.id), id = `model:${variant.id}`
    if (items.some(item => item.id === id)) continue
    const downloadBytes = installed ? 0 : Math.max(0, variant.asset.bytes - (options.resumed?.(id) ?? 0))
    items.push({ id, name: `${variant.asset.label}`, group: localModelGroup(ref.model),
      action: installed ? 'reuse' : downloadBytes ? 'download' : 'verify', bytes: variant.asset.bytes, downloadBytes, source: variant.asset.url })
  }
  if (options.supported) for (const group of groups) {
    const gpu = runtimeBackend(group, policy, devices, components)
      ?? (options.forceGpu && ['win32', 'linux'].includes(target.platform) ? (group === 'qwen-speech' ? 'vulkan' : devices.find(item => item.backend === 'cuda')?.backend ?? 'vulkan') : undefined)
    if (gpu) backend = gpu
    const wanted = components.filter(item => item.group === group && (item.backend === 'cpu' || item.backend === 'common' || item.backend === gpu))
    // Linux also needs Vulkan enumeration on NVIDIA hosts to discover secondary Intel/AMD GPUs.
    if (gpu && (gpu === 'vulkan' || target.platform === 'linux') && !devices.some(device => device.backend === 'vulkan')
      && (group !== 'qwen-speech' || !devices.some(device => !device.integrated && device.memoryMiB > 0))) {
      const probe = components.find(item => item.id === 'translator-vulkan')
      if (probe) wanted.push(probe)
    }
    for (const item of wanted) if (!items.some(existing => existing.id === item.id)) {
      if (item.id.startsWith('ffmpeg-') && items.some(existing => existing.id.startsWith('ffmpeg-'))) continue
      const downloadBytes = item.installed || item.delivery === 'bundled' ? 0 : Math.max(0, item.bytes - (options.resumed?.(item.id) ?? 0))
      items.push({ id: item.id, name: `${item.name}${item.backend === 'common' ? '' : ` · ${item.backend.toUpperCase()}`}`, group: item.group,
        action: item.installed ? 'reuse' : item.delivery === 'bundled' ? 'install' : downloadBytes ? 'download' : 'verify', bytes: item.bytes, downloadBytes, source: item.source })
    }
  }
  return { items, backend, downloadBytes: items.reduce((sum, item) => sum + item.downloadBytes, 0) }
}
