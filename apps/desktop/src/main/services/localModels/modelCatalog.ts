import type { LocalModelDownloadSource, LocalModelId, LocalTranslationModelId } from '@shared/desktop/localModels'
import { aiRuntimeAssets, type AiRuntimeAsset, type AiRuntimeTarget } from './runtimeManifest'
import repositories from './modelCatalogAssets.json'
import { LOCAL_MODEL_NOTICES } from './modelNotices'

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
  kotoba: 'kotoba-q5_0', qwen3: 'qwen3-q4_k_m', 'hy-mt2-7b': 'hy-mt2-7b-q4_k_m'
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
  kotoba: { name: 'Kotoba Whisper', version: 'v2.0 GGML', purpose: '日语语音转写',
    exportName: 'Kotoba-Whisper-ASR', notice: 'Kotoba-Whisper v2.0: Apache-2.0\nhttps://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml\n',
    format: 'GGML', assetId: 'kotoba', runtimeAssets: ['kotoba', 'whisper', 'ffmpeg', 'vad'] },
  qwen3: { name: 'Qwen3 1.7B', version: 'Qwen3-1.7B', purpose: '本地文本翻译',
    exportName: 'Qwen3-1.7B', notice: 'Qwen3-1.7B: Apache-2.0; GGUF published by Qwen or bartowski\n',
    format: 'GGUF', assetId: 'translation-model', runtimeAssets: ['translation-model', 'translator'] },
  'hy-mt2-7b': { name: 'HY-MT2 7B', version: 'Hy-MT2-7B', purpose: '本地文本翻译',
    exportName: 'Hy-MT2-7B', notice: LOCAL_MODEL_NOTICES['hy-mt2-7b'],
    format: 'GGUF', assetId: 'translation-model', runtimeAssets: ['translation-model', 'translator'] }
}

export const LOCAL_MODEL_VARIANTS: readonly LocalModelVariant[] = repositories.flatMap(repository => repository.assets.map(file => {
  const model = repository.model as LocalModelId
  const definition = LOCAL_MODEL_DEFINITIONS[model]
  if (!definition) throw new Error('未知的本地模型目录家族')
  const publisher = repository.repoId.split('/')[0]
  const id = `${model}-${publisher === 'Qwen' ? 'official-' : ''}${file.precision.toLowerCase()}`
  const assetId = definition.assetId
  const family = { kotoba: 'kotoba-whisper-v2.0', qwen3: 'qwen3-1.7b', 'hy-mt2-7b': 'hy-mt2-7b' }[model]
  return {
    id, model, publisher, precision: file.precision.toUpperCase(), format: definition.format,
    recommended: id === DEFAULT_LOCAL_MODEL_VARIANTS[model],
    asset: { id: assetId, label: `${definition.name} · ${file.precision.toUpperCase()} · ${publisher}`,
      ...(model === 'kotoba' ? {} : { translationModelId: model }),
      filename: file.rfilename,
      model: { family, publisher, revision: repository.revision, precision: file.precision.toUpperCase(), format: definition.format },
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
