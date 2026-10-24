import pins from './runtimeDistributions.json'
import type { AiRuntimeAsset, AiRuntimeTarget } from './runtimeManifest'

/** Reviewed immutable release data; never fetch a remote catalog while installing. */
export function runtimeDistributionAssets(target: AiRuntimeTarget, backend?: 'cuda' | 'vulkan'): AiRuntimeAsset[] {
  const labels: Record<string, string> = { whisper: '日语识别运行库', translator: '中文翻译运行库', ffmpeg: '音频提取运行库', cuda: 'CUDA 翻译运行依赖' }
  const windows = target.platform === 'win32'
  const filenames: Record<string, string> = {
    whisper: backend === 'cuda' ? 'whisper-cuda.zip' : windows ? 'whisper.zip' : 'whisper.tar.gz',
    translator: backend === 'cuda' ? 'llama-cuda.zip' : backend === 'vulkan' ? 'llama-vulkan.zip' : windows ? 'translator.zip' : 'translator.tar.gz',
    ffmpeg: windows ? 'ffmpeg.zip' : 'ffmpeg.tar.gz', cuda: 'cudart.zip'
  }
  const order = backend === 'cuda' ? ['translator', 'cuda', 'whisper'] : ['whisper', 'translator', 'ffmpeg']
  return pins.assets.filter(entry => entry.target === `${target.platform}-${target.arch}`
    && (backend ? entry.backend === backend : !['cuda', 'vulkan'].includes(entry.backend)))
    .sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id)).map(entry => ({
    id: entry.id as AiRuntimeAsset['id'], label: labels[entry.id], filename: windows ? filenames[entry.id] : entry.name,
    archive: true, bytes: entry.bytes, sha256: entry.sha256, url: entry.url,
    archivePrefix: entry.archivePrefix ?? undefined,
    ...(backend ? { backend } : {}),
    ...(backend === 'cuda' ? { expandedBytes: (entry.id === 'whisper' ? 3 : 2) * 1024 ** 3 } : {}),
    ...(target.platform === 'darwin' && entry.id === 'whisper' && entry.release === 'whisper-b5130-r2'
      ? { legacyInstalledIdentity: `whisper-b5130-ffmpeg-8.1.3-v1:${target.platform}-${target.arch}:whisper` } : {})
  }))
}

/** The pinned llama x64 build disables Metal; its arm64 base package includes it.
 * Distribution backend labels also classify base downloads, so CPU does not imply CPU-only. */
export function runtimeSupportsMetal(target: AiRuntimeTarget, id: 'whisper' | 'translator'): boolean {
  return target.platform === 'darwin' && (target.arch === 'arm64' || target.arch === 'x64' && id === 'whisper')
}
