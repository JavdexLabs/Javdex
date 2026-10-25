import pins from './runtimeDistributions.json'
import type { AiRuntimeAsset, AiRuntimeTarget } from './runtimeManifest'

// audio.cpp-native standalone GGUFs include the tokenizer/processor sidecars.
export const QWEN_ASR_REVISION = '661a224e9d9adbd49c01626f85e426f5f425d771'
export const AUDIOCPP_VERSION = 'v0.9.2-drama3-base-small'
export const qwenAsrSupported = (target: AiRuntimeTarget): boolean => target.platform === 'win32' && target.arch === 'x64'
export const QWEN_ALIGNER: AiRuntimeAsset = {
  id: 'qwen-aligner', label: 'Qwen3 ForcedAligner 0.6B · Q8_0',
  filename: 'qwen3-forced-aligner-0.6b-q8_0.gguf', bytes: 1129966496,
  sha256: '75209490b11cec2b0db749ca5f4ff92266f58efd30f7fd04d9eb2a3ac9cc929f',
  url: `https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/${QWEN_ASR_REVISION}/Qwen3-ForcedAligner-0.6B-GGUF/qwen3-forced-aligner-0.6b-q8_0.gguf`,
  model: { family: 'qwen3-forced-aligner-0.6b', publisher: 'audio-cpp', revision: QWEN_ASR_REVISION, precision: 'Q8_0', format: 'GGUF' }
}
export function audioCppAsset(target: AiRuntimeTarget, gpu = false): AiRuntimeAsset[] {
  if (!qwenAsrSupported(target)) return []
  return pins.optionalAssets.filter(asset => asset.id === 'audiocpp' && asset.target === `${target.platform}-${target.arch}`
    && asset.backend === (gpu ? 'vulkan' : 'cpu')).map(asset => ({
    id: 'audiocpp', label: `audio.cpp 语音引擎 · ${gpu ? 'Vulkan' : 'CPU'}`, filename: asset.name,
    archive: true, bytes: asset.bytes, sha256: asset.sha256, url: asset.url,
    ...(gpu ? { backend: 'vulkan' as const } : {})
  }))
}
