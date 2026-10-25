import type { LocalTranslationModelId } from '@shared/desktop/localModels'
import type { RuntimePackagePin } from './runtimePackage'
import { runtimeDistributionAssets } from './runtimeDistributionAssets'

/** Fixed upstream releases and repository revisions, never resolve `latest` at installation. */
export interface AiRuntimeAsset {
  id: 'whisper' | 'translator' | 'ffmpeg' | 'kotoba' | 'translation-model' | 'vad' | 'cuda' | 'audiocpp' | 'qwen-asr' | 'qwen-aligner'
  label: string
  url: string
  sha256: string
  bytes: number
  filename: string
  model?: { family: string; publisher: string; revision: string; precision: string; format: 'GGML' | 'GGUF' | 'Safetensors' }
  /** Pinned processor/tokenizer files installed beside non-standalone weights. */
  supportFiles?: Array<Pick<AiRuntimeAsset, 'filename' | 'url' | 'sha256' | 'bytes'>>
  modelNotice?: string
  archive?: true
  /** POSIX archives retain their bin/lib layout after removing this fixed prefix. */
  archivePrefix?: string
  translationModelId?: LocalTranslationModelId
  backend?: 'cuda' | 'vulkan'
  /** Reviewed uncompressed limit for large GPU DLL distributions. */
  expandedBytes?: number
  /** Fixed Javdex Runtime flat-package contract, after outer archive verification. */
  runtimePackage?: RuntimePackagePin
  /** Only a reviewed same-engine installation may survive a distribution-only move. */
  legacyInstalledIdentity?: string
}
export function modelAssetFiles(asset: AiRuntimeAsset): AiRuntimeAsset[] {
  const { supportFiles, ...weights } = asset
  return [weights, ...(supportFiles ?? []).map(file => ({ ...weights, ...file }))]
}
export function modelAssetBytes(asset: AiRuntimeAsset): number {
  return modelAssetFiles(asset).reduce((total, file) => total + file.bytes, 0)
}
const portableAssets: readonly AiRuntimeAsset[] = [
  { id: 'kotoba', label: 'Kotoba 日语模型', filename: 'ggml-kotoba-whisper-v2.0-q5_0.bin',
    model: { family: 'kotoba-whisper-v2.0', publisher: 'kotoba-tech', revision: 'e3a0cf6a62b95911703cfb97d819292e058f12c3', precision: 'Q5_0', format: 'GGML' }, bytes: 537819875,
    url: 'https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/e3a0cf6a62b95911703cfb97d819292e058f12c3/ggml-kotoba-whisper-v2.0-q5_0.bin',
    sha256: '4a3b92192b5d3578ff854a5876213e2e27af0c2d357492c2d14271e82c303658' },
  { id: 'translation-model', label: '离线中文翻译模型', filename: 'Qwen_Qwen3-1.7B-Q4_K_M.gguf',
    model: { family: 'qwen3-1.7b', publisher: 'bartowski', revision: 'dcb19155b962dbb6389f4691a982043a8e651022', precision: 'Q4_K_M', format: 'GGUF' }, bytes: 1282439584,
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/dcb19155b962dbb6389f4691a982043a8e651022/Qwen_Qwen3-1.7B-Q4_K_M.gguf',
    sha256: '72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb' },
  { id: 'vad', label: '语音检测模型', filename: 'ggml-silero-v6.2.0.bin',
    model: { family: 'silero-vad-v6.2', publisher: 'ggml-org', revision: '9ffd54a1e1ee413ddf265af9913beaf518d1639b', precision: 'default', format: 'GGML' }, bytes: 885098,
    url: 'https://github.com/JavdexLabs/javdex-runtime/releases/download/silero-v6.2-r1/ggml-silero-v6.2.0.bin',
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' }
]
export const LOCAL_MODEL_ASSETS: readonly AiRuntimeAsset[] = [...runtimeDistributionAssets({ platform: 'win32', arch: 'x64' }), ...portableAssets]
export const LOCAL_MODEL_DOWNLOAD_BYTES = LOCAL_MODEL_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0)

export interface AiRuntimeTarget { platform: string; arch: string }
export const currentAiRuntimeTarget = (): AiRuntimeTarget => ({ platform: process.platform, arch: process.arch })
export const aiRuntimeTargetSupported = ({ platform, arch }: AiRuntimeTarget): boolean =>
  (platform === 'win32' && arch === 'x64') || (['darwin', 'linux'].includes(platform) && ['arm64', 'x64'].includes(arch))
export const AI_RUNTIME_PLATFORM_MESSAGE = '本地推理支持 Windows x64、macOS 13.3+ arm64／x64 和 Linux arm64／x64（glibc 2.38+、GCC 14 C++ 运行库，例如已更新的 Ubuntu 24.04）'
export const AI_RUNTIME_ASSET_IDS: readonly AiRuntimeAsset['id'][] = ['whisper', 'translator', 'ffmpeg', 'kotoba', 'translation-model', 'vad']
/** Weights are portable; executables never cross platform/architecture boundaries. */
export function aiRuntimeAssets(target: AiRuntimeTarget = currentAiRuntimeTarget()): readonly AiRuntimeAsset[] {
  if (target.platform === 'win32' && target.arch === 'x64') return LOCAL_MODEL_ASSETS
  if (!aiRuntimeTargetSupported(target)) return portableAssets
  return [...runtimeDistributionAssets(target), ...portableAssets]
}
