import type { LocalTranslationModelId } from '@shared/desktop/localModels'

/** Fixed upstream releases and repository revisions, never resolve `latest` at installation. */
export interface AiRuntimeAsset {
  id: 'whisper' | 'translator' | 'ffmpeg' | 'kotoba' | 'translation-model' | 'vad'
  label: string
  url: string
  sha256: string
  bytes: number
  filename: string
  archive?: true
  /** POSIX archives retain their bin/lib layout after removing this fixed prefix. */
  archivePrefix?: string
  translationModelId?: LocalTranslationModelId
}
// Storage identity stays stable when the catalog grows, preserving downloaded tools and weights.
export const AI_SUBTITLE_RUNTIME_VERSION = 'kotoba-v2-q5-qwen3-1.7b-q4-20261006'
export const AI_SUBTITLE_ASR_VERSION = 'kotoba-v2-q5-silero-v6.2-whisper-b5130-decode-v1'
export const AI_SUBTITLE_TRANSLATION_VERSION = 'qwen3-1.7b-q4-llama-b11435-prompt-v1'
export const AI_SUBTITLE_ASSETS: readonly AiRuntimeAsset[] = [
  { id: 'whisper', label: '日语识别运行库', filename: 'whisper.zip', archive: true, bytes: 8573270,
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
    sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c' },
  { id: 'translator', label: '中文翻译运行库', filename: 'translator.zip', archive: true, bytes: 19399527,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11435/llama-b11435-bin-win-cpu-x64.zip',
    sha256: '3ed50261147e260d80f5cdc7bdccfa13a94882be560a4438e7a69fa519c93fb7' },
  { id: 'ffmpeg', label: '音频提取运行库', filename: 'ffmpeg.zip', archive: true, bytes: 80993040,
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-05-13-07/ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-shared-8.1.zip',
    sha256: '534653068a3ac64ed5d02361e1ad59e4cb99a713f425444b470514999e437473' },
  { id: 'kotoba', label: 'Kotoba 日语模型', filename: 'kotoba-q5.bin', bytes: 537819875,
    url: 'https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/e3a0cf6a62b95911703cfb97d819292e058f12c3/ggml-kotoba-whisper-v2.0-q5_0.bin',
    sha256: '4a3b92192b5d3578ff854a5876213e2e27af0c2d357492c2d14271e82c303658' },
  { id: 'translation-model', label: '离线中文翻译模型', filename: 'qwen3-q4.gguf', bytes: 1282439584,
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/dcb19155b962dbb6389f4691a982043a8e651022/Qwen_Qwen3-1.7B-Q4_K_M.gguf',
    sha256: '72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb' },
  { id: 'vad', label: '语音检测模型', filename: 'silero.bin', bytes: 885098,
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' }
]
export const AI_SUBTITLE_DOWNLOAD_BYTES = AI_SUBTITLE_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0)

export interface AiRuntimeTarget { platform: string; arch: string }
export const currentAiRuntimeTarget = (): AiRuntimeTarget => ({ platform: process.platform, arch: process.arch })
export const aiRuntimeTargetSupported = ({ platform, arch }: AiRuntimeTarget): boolean =>
  (platform === 'win32' && arch === 'x64') || (['darwin', 'linux'].includes(platform) && ['arm64', 'x64'].includes(arch))
export const AI_RUNTIME_PLATFORM_MESSAGE = '本地推理支持 Windows x64、macOS 13.3+ arm64／x64 和 Linux arm64／x64（glibc 2.38+、GCC 14 C++ 运行库，例如已更新的 Ubuntu 24.04）'
export const AI_RUNTIME_ASSET_IDS: readonly AiRuntimeAsset['id'][] = ['whisper', 'translator', 'ffmpeg', 'kotoba', 'translation-model', 'vad']
// These two macOS tools are built from pinned sources and shipped outside app.asar.
export const AI_MAC_BUNDLE_VERSION = 'whisper-b5130-ffmpeg-8.1.3-v1'

const translatorReleases: Record<string, { name: string; bytes: number; sha256: string }> = {
  'darwin-arm64': { name: 'macos-arm64', bytes: 11971075, sha256: '65f564a94c328dee846a395796d060671fb64f4334a84857c222b2416f039545' },
  'darwin-x64': { name: 'macos-x64', bytes: 11487091, sha256: '41ee358ed26b426f2798f459b6b8607416db7e0fa472bae955210f1908627b1b' },
  'linux-arm64': { name: 'ubuntu-arm64', bytes: 13680816, sha256: '5eecb754f61f21fd70799edb1db1d1a6d6cbdf7d1716e8781c99eb4841fd39f8' },
  'linux-x64': { name: 'ubuntu-x64', bytes: 17692966, sha256: 'ee617d7af304985e268fbc33bdd8fe44110f1dc2f599ecb27bdf08890e6e6e4c' }
}
const whisperReleases: Record<string, { bytes: number; sha256: string }> = {
  arm64: { bytes: 4605905, sha256: '93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6' },
  x64: { bytes: 9793438, sha256: '53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32' }
}
const ffmpegReleases: Record<string, { name: string; bytes: number; sha256: string }> = {
  arm64: { name: 'linuxarm64', bytes: 56258024, sha256: 'aa9009a8e5f04245026f3de47be254ec7391946b9da12fe3794d9603d4509f01' },
  x64: { name: 'linux64', bytes: 65887340, sha256: '273c61732382243d3ae87802e3197c417c5c6a2e1098352e8d5fec3cde002b29' }
}
/** Weights are portable; executables never cross platform/architecture boundaries. */
export function aiRuntimeAssets(target: AiRuntimeTarget = currentAiRuntimeTarget()): readonly AiRuntimeAsset[] {
  if (target.platform === 'win32' && target.arch === 'x64') return AI_SUBTITLE_ASSETS
  const weights = AI_SUBTITLE_ASSETS.filter(asset => !asset.archive)
  if (!aiRuntimeTargetSupported(target)) return weights
  const translator = translatorReleases[`${target.platform}-${target.arch}`]
  const tools: AiRuntimeAsset[] = [{ id: 'translator', label: '中文翻译运行库', archive: true,
    filename: 'translator.tar.gz', archivePrefix: 'llama-b11435', bytes: translator.bytes, sha256: translator.sha256,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/b11435/llama-b11435-bin-${translator.name}.tar.gz` }]
  if (target.platform === 'linux') {
    const whisper = whisperReleases[target.arch], ffmpeg = ffmpegReleases[target.arch]
    const ffmpegName = `ffmpeg-n8.1.3-14-g330caae0c1-${ffmpeg.name}-lgpl-shared-8.1`
    tools.unshift({ id: 'whisper', label: '日语识别运行库', archive: true, filename: 'whisper.tar.gz',
      archivePrefix: `whisper-bin-ubuntu-${target.arch}`, bytes: whisper.bytes, sha256: whisper.sha256,
      url: `https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-ubuntu-${target.arch}.tar.gz` })
    tools.push({ id: 'ffmpeg', label: '音频提取运行库', archive: true, filename: 'ffmpeg.tar.xz',
      archivePrefix: ffmpegName, bytes: ffmpeg.bytes, sha256: ffmpeg.sha256,
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-05-13-07/${ffmpegName}.tar.xz` })
  }
  return [...tools, ...weights]
}
