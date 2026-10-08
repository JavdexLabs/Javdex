import type { LocalModelDownloadSource, LocalModelId, LocalTranslationModelId } from '@shared/desktop/localModels'
import { AI_SUBTITLE_ASSETS, aiRuntimeAssets, type AiRuntimeAsset, type AiRuntimeTarget } from '../../player/aiSubtitles/runtimeManifest'
import repositories from './modelCatalogAssets.json'
import { LOCAL_MODEL_NOTICES } from '../../player/aiSubtitles/modelNotices'

export interface LocalModelVariant {
  id: string
  model: LocalModelId
  precision: string
  format: 'GGML' | 'GGUF'
  recommended: boolean
  publisher: string
  asset: AiRuntimeAsset
}

export const DEFAULT_LOCAL_MODEL_VARIANTS: Record<LocalModelId, string> = {
  kotoba: 'kotoba-q5_0', qwen3: 'qwen3-q4_k_m', 'hy-mt2-7b': 'hy-mt2-7b-q4_k_m', 'index-translate-9b': 'index-translate-9b-q4_k_m'
}

interface LocalModelDefinition {
  name: string
  version: string
  purpose: string
  exportName: string
  notice: string
  format: 'GGML' | 'GGUF'
  assetId: AiRuntimeAsset['id']
  runtimeAssets: AiRuntimeAsset['id'][]
}
export const LOCAL_MODEL_DEFINITIONS: Record<LocalModelId, LocalModelDefinition> = {
  kotoba: { name: 'Kotoba Whisper', version: 'v2.0 GGML', purpose: 'AI 字幕日语识别（2.2 增强尚未接入）',
    exportName: 'Kotoba-Whisper-ASR', notice: 'Kotoba-Whisper v2.0: Apache-2.0\nhttps://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml\n',
    format: 'GGML', assetId: 'kotoba', runtimeAssets: ['kotoba', 'whisper', 'ffmpeg', 'vad'] },
  qwen3: { name: 'Qwen3 1.7B', version: 'Qwen3-1.7B', purpose: 'AI 文本翻译与字幕中文翻译',
    exportName: 'Qwen3-1.7B', notice: 'Qwen3-1.7B: Apache-2.0; GGUF published by Qwen or bartowski\n',
    format: 'GGUF', assetId: 'translation-model', runtimeAssets: ['translation-model', 'translator'] },
  'hy-mt2-7b': { name: 'HY-MT2 7B', version: 'Hy-MT2-7B', purpose: 'AI 文本翻译与字幕中文翻译',
    exportName: 'Hy-MT2-7B', notice: LOCAL_MODEL_NOTICES['hy-mt2-7b'],
    format: 'GGUF', assetId: 'translation-model', runtimeAssets: ['translation-model', 'translator'] },
  'index-translate-9b': { name: 'Index-Translate 9B', version: 'Index-Translate-9B', purpose: 'AI 文本翻译与字幕中文翻译',
    exportName: 'Index-Translate-9B', notice: LOCAL_MODEL_NOTICES['index-translate-9b'],
    format: 'GGUF', assetId: 'translation-model', runtimeAssets: ['translation-model', 'translator'] }
}

// Official v2.2 builds on v2.0 and adds a separate postprocessing pipeline. The
// public GGML files are v2.0 ASR files, not a substitute for that pipeline.
// Frozen filenames/hashes/revisions are documented in KOTOBA_22_MODEL_STORE_RESEARCH.md.
export const LOCAL_MODEL_VARIANTS: readonly LocalModelVariant[] = repositories.flatMap(repository => repository.assets.map(file => {
  const model = repository.model as LocalModelId
  const definition = LOCAL_MODEL_DEFINITIONS[model]
  if (!definition) throw new Error('未知的本地模型目录家族')
  const publisher = repository.repoId.split('/')[0]
  const id = `${model}-${publisher === 'Qwen' ? 'official-' : ''}${file.precision.toLowerCase()}`
  const assetId = definition.assetId
  const legacy = AI_SUBTITLE_ASSETS.find(asset => asset.id === assetId)
  return {
    id, model, publisher, precision: file.precision.toUpperCase(), format: definition.format,
    recommended: id === DEFAULT_LOCAL_MODEL_VARIANTS[model],
    asset: { id: assetId, label: `${definition.name} · ${file.precision.toUpperCase()} · ${publisher}`,
      ...(model === 'kotoba' ? {} : { translationModelId: model }),
      // Preserve existing on-disk names for the exact legacy assets, without copying or redownloading them.
      filename: legacy?.sha256 === file.sha256 ? legacy.filename : file.rfilename,
      bytes: file.size, sha256: file.sha256,
      url: `https://huggingface.co/${repository.repoId}/resolve/${repository.revision}/${file.rfilename}` }
  }
}))

export function localModelVariant(model: LocalModelId, variant = DEFAULT_LOCAL_MODEL_VARIANTS[model]): LocalModelVariant {
  const match = LOCAL_MODEL_VARIANTS.find(item => item.model === model && item.id === variant)
  if (!match) throw new Error('未知或不匹配的本地模型精度')
  return match
}

export function localModelAssets(selection: Record<LocalModelId, string>, translationModel: LocalTranslationModelId = 'qwen3', target?: AiRuntimeTarget, source: LocalModelDownloadSource = 'official'): readonly AiRuntimeAsset[] {
  return aiRuntimeAssets(target).map(asset => asset.id === 'kotoba' ? localModelVariant('kotoba', selection.kotoba).asset
    : asset.id === 'translation-model' ? localModelVariant(translationModel, selection[translationModel]).asset : asset).map(asset => {
    const url = new URL(asset.url)
    if (source !== 'hf-mirror' || url.origin !== 'https://huggingface.co') return asset
    url.hostname = 'hf-mirror.com'
    return { ...asset, url: url.href }
  })
}
