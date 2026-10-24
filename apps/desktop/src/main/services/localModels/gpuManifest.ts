import type { AiRuntimeAsset, AiRuntimeTarget } from './runtimeManifest'
import { runtimeDistributionAssets } from './runtimeDistributionAssets'

/** CUDA 12.4 covers the initial Windows NVIDIA target; unsupported GPUs fail the native probe. */
export function gpuRuntimeAssets(target: AiRuntimeTarget, backend: 'cuda' | 'vulkan'): AiRuntimeAsset[] {
  if (target.platform === 'linux' && target.arch === 'x64') return runtimeDistributionAssets(target, backend)
  if (target.platform !== 'win32' || target.arch !== 'x64') return []
  if (backend === 'vulkan') return [...runtimeDistributionAssets(target, backend),
    { id: 'whisper', label: 'Vulkan 语音识别运行库', backend, archive: true,
      filename: 'whisper-b5130-r1-win32-x64-vulkan.zip', bytes: 18095994, sha256: '4ebbd89cd9ce82685482b7c63be1ebeb13f5d91ee1e46c451f76bc809b36bfc5',
      expandedBytes: 58161361, url: 'https://github.com/JavdexLabs/javdex-runtime/releases/download/whisper-b5130-r1/whisper-b5130-r1-win32-x64-vulkan.zip',
      runtimePackage: { version: 'whisper-b5130-r1', commit: '21bef11113cff0544cdc615fa93767994f4d9cde', runId: 39089754724,
        upstreamCommit: '927cfce34f31707e17f2bff35c349632fb9e2c3a' },
      legacyInstalledIdentity: 'whisper-b5130-vulkan-v1:win32-x64:whisper' }]
  return runtimeDistributionAssets(target, backend)
}
