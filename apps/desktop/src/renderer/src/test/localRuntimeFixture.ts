import type { LocalModelGroup, LocalPreparationPlan, LocalRuntimeComponent } from '@shared/desktop/localModels'

/** Renderer tests consume contract DTOs, never main-process installation logic. */
export const runtimeComponentsFixture: LocalRuntimeComponent[] = [
  { id: 'whisper-cpu', group: 'speech', name: '语音引擎', version: 'b5130', backend: 'cpu', delivery: 'download', bytes: 8573270, installed: false, source: 'https://github.com/ggml-org/whisper.cpp' },
  { id: 'ffmpeg-common', group: 'speech', name: '音频提取工具', version: '8.1.3', backend: 'common', delivery: 'download', bytes: 80993040, installed: false, source: 'https://github.com/BtbN/FFmpeg-Builds' },
  { id: 'vad-common', group: 'speech', name: '语音检测模型', version: 'silero-vad-v6.2', backend: 'common', delivery: 'download', bytes: 885098, installed: false, source: 'https://huggingface.co/ggml-org/whisper-vad' },
  { id: 'translator-cpu', group: 'text', name: '文本引擎', version: 'b11435', backend: 'cpu', delivery: 'download', bytes: 19399527, installed: false, source: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'whisper-cuda', group: 'speech', name: '语音引擎', version: 'b5130', backend: 'cuda', delivery: 'download', bytes: 674539285, installed: false, source: 'https://github.com/ggml-org/whisper.cpp' },
  { id: 'translator-cuda', group: 'text', name: '文本引擎', version: 'b11435', backend: 'cuda', delivery: 'download', bytes: 264473456, installed: false, source: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'cuda-cuda', group: 'text', name: 'CUDA/cuBLAS 依赖', version: '12.4', backend: 'cuda', delivery: 'download', bytes: 391443627, installed: false, source: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'translator-vulkan', group: 'text', name: '文本引擎', version: 'b11435', backend: 'vulkan', delivery: 'download', bytes: 33337420, installed: false, source: 'https://github.com/ggml-org/llama.cpp' },
  { id: 'whisper-vulkan', group: 'speech', name: '语音引擎', version: 'b5130', backend: 'vulkan', delivery: 'download', bytes: 18095994, installed: false, source: 'https://github.com/JavdexLabs/javdex-runtime/releases/download/whisper-b5130-r1/whisper-b5130-r1-win32-x64-vulkan.zip' }
]

export function runtimePlanFixture(group: LocalModelGroup, components: LocalRuntimeComponent[], backend?: 'cuda' | 'vulkan', probe = false): LocalPreparationPlan {
  const items = components.filter(item => item.group === group && ['cpu', 'common', backend].includes(item.backend)
    || probe && item.id === 'translator-vulkan').map(item => ({
    id: item.id, name: item.name, group: item.group,
    action: item.installed ? 'reuse' as const : item.delivery === 'bundled' ? 'install' as const : 'download' as const,
    bytes: item.bytes, downloadBytes: item.installed || item.delivery === 'bundled' ? 0 : item.bytes, source: item.source
  }))
  return { items, backend: backend ?? 'cpu', downloadBytes: items.reduce((sum, item) => sum + item.downloadBytes, 0) }
}
