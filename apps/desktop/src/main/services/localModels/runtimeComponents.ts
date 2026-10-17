import type { LocalAccelerationPolicy, LocalGpuDevice, LocalModelGroup, LocalModelRef, LocalPreparationPlan, LocalRuntimeComponent } from '@shared/desktop/localModels'
import { aiRuntimeAssets, type AiRuntimeAsset, type AiRuntimeTarget, AI_MAC_BUNDLE_VERSION } from './runtimeManifest'
import { gpuRuntimeAssets } from './gpuManifest'
import { localModelVariant } from './modelCatalog'

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
    const bundled = !!asset?.bundledVersion || (target.platform === 'darwin' && (id === 'whisper' || id === 'ffmpeg'))
    return { assetId: id, asset, component: {
      id: `${id}-${backend}`, group: id === 'translator' || id === 'cuda' ? 'text' : 'speech',
      name: names[id], backend, delivery: bundled ? 'bundled' : 'download', bytes: asset?.bytes ?? 0,
      version: asset?.model?.family ?? (id === 'whisper' ? 'b5130' : id === 'ffmpeg' ? '8.1.3' : id === 'cuda' ? '12.4' : 'b11435'),
      source: bundled ? `应用内置 · ${asset?.bundledVersion ?? AI_MAC_BUNDLE_VERSION}` : asset?.url ?? ''
    } }
  }
  return [
    ...baseIds.map(id => definition(id, id === 'ffmpeg' || id === 'vad' ? 'common' : 'cpu', base.find(asset => asset.id === id))),
    ...(['cuda', 'vulkan'] as const).flatMap(backend => gpuRuntimeAssets(target, backend)
      .map(asset => definition(asset.id as 'whisper' | 'translator' | 'cuda', backend, asset)))
  ]
}

/** Match execution selection, including an installed alternative backend in automatic mode. */
export function runtimeBackend(group: LocalModelGroup, policy: LocalAccelerationPolicy, devices: LocalGpuDevice[], components: LocalRuntimeComponent[]): 'cuda' | 'vulkan' | undefined {
  if (policy.mode === 'cpu') return undefined
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
  const { groups, components, policy, devices, target } = options
  const items: LocalPreparationPlan['items'] = []
  let backend: LocalPreparationPlan['backend'] = target.platform === 'darwin' && policy.mode === 'auto' ? 'metal' : 'cpu'
  for (const ref of options.refs ?? []) {
    const variant = localModelVariant(ref.model, ref.variant), installed = options.installed(variant.id), id = `model:${variant.id}`
    if (items.some(item => item.id === id)) continue
    const downloadBytes = installed ? 0 : Math.max(0, variant.asset.bytes - (options.resumed?.(id) ?? 0))
    items.push({ id, name: `${variant.asset.label}`, group: ref.model === 'kotoba' ? 'speech' : 'text',
      action: installed ? 'reuse' : downloadBytes ? 'download' : 'verify', bytes: variant.asset.bytes, downloadBytes, source: variant.asset.url })
  }
  if (options.supported) for (const group of groups) {
    const gpu = runtimeBackend(group, policy, devices, components)
      ?? (options.forceGpu && target.platform === 'win32' ? (devices.find(item => item.backend === 'cuda')?.backend ?? 'vulkan') : undefined)
    if (gpu) backend = gpu
    const wanted = components.filter(item => item.group === group && (item.backend === 'cpu' || item.backend === 'common' || item.backend === gpu))
    // Vulkan device enumeration currently uses the text engine, even for speech-only setup.
    if (gpu === 'vulkan' && !devices.some(device => device.backend === 'vulkan')) {
      const probe = components.find(item => item.id === 'translator-vulkan')
      if (probe) wanted.push(probe)
    }
    for (const item of wanted) if (!items.some(existing => existing.id === item.id)) {
      const downloadBytes = item.installed || item.delivery === 'bundled' ? 0 : Math.max(0, item.bytes - (options.resumed?.(item.id) ?? 0))
      items.push({ id: item.id, name: `${item.name}${item.backend === 'common' ? '' : ` · ${item.backend.toUpperCase()}`}`, group: item.group,
        action: item.installed ? 'reuse' : item.delivery === 'bundled' ? 'install' : downloadBytes ? 'download' : 'verify', bytes: item.bytes, downloadBytes, source: item.source })
    }
  }
  return { items, backend, downloadBytes: items.reduce((sum, item) => sum + item.downloadBytes, 0) }
}
