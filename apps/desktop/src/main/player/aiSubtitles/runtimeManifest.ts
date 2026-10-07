/** Fixed upstream releases and repository revisions, never resolve `latest` at installation. */
export interface AiRuntimeAsset {
  id: 'whisper' | 'translator' | 'ffmpeg' | 'kotoba' | 'translation-model' | 'vad'
  label: string
  url: string
  sha256: string
  bytes: number
  filename: string
  archive?: true
}
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
