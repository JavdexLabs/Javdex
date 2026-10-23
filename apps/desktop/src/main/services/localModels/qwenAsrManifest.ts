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
  const filename = `audio-${AUDIOCPP_VERSION}-bin-windows-x64-${gpu ? 'vulkan' : 'cpu'}.zip`
  return [{ id: 'audiocpp', label: `audio.cpp 语音引擎 · ${gpu ? 'Vulkan' : 'CPU'}`, filename, archive: true,
    bytes: gpu ? 63369491 : 28876613,
    sha256: gpu ? '7d002f9989357ff4196c275d06d10932b7683d0a485c37b39e0b7a69c7eb42f6' : 'cc34162b028d2b948d174259d58f63a1caf42fd45884bfb32fb632bdc062dd86',
    url: `https://github.com/0xShug0/audio.cpp/releases/download/${AUDIOCPP_VERSION}/${filename}`,
    ...(gpu ? { backend: 'vulkan' as const } : {}) }]
}
