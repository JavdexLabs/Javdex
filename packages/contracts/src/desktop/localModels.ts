export const LOCAL_TRANSLATION_MODEL_IDS = ['qwen3', 'hy-mt2-7b', 'index-translate-9b'] as const
export const LOCAL_MODEL_IDS = ['qwen3', 'kotoba', 'hy-mt2-7b', 'index-translate-9b'] as const
export type LocalTranslationModelId = typeof LOCAL_TRANSLATION_MODEL_IDS[number]
export type LocalModelId = typeof LOCAL_MODEL_IDS[number]
export type LocalTranslationMode = 'app-default' | 'local'
export type LocalModelCommand =
  | { action: 'download' | 'delete' | 'export'; model: LocalModelId; variant?: string }
  | { action: 'select'; model: LocalModelId; variant: string }
  | { action: 'cancel-download' }
  | { action: 'choose-location' }
  | { action: 'reset-location' }
  | { action: 'translation'; mode: LocalTranslationMode }
  | { action: 'translation-model'; model: LocalTranslationModelId }
export interface LocalModelVariantView {
  id: string
  precision: string
  format: 'GGML' | 'GGUF'
  bytes: number
  installed: boolean
  inUse: boolean
  recommended: boolean
  source: string
  publisher: string
}
export interface LocalModelView {
  id: LocalModelId
  name: string
  purpose: string
  bytes: number
  installed: boolean
  inUse: boolean
  version: string
  selectedVariant: string
  variants: LocalModelVariantView[]
}
export interface LocalModelSnapshot {
  supported: boolean
  directory: string
  defaultDirectory: string
  translation: LocalTranslationMode
  translationModel: LocalTranslationModelId
  models: LocalModelView[]
  operation: 'download' | 'delete' | 'export' | 'relocate' | 'configure' | null
  activeModel: LocalModelId | null
  activeVariant: string | null
  downloadBytes: number
  downloadTotal: number
  downloadLabel: string | null
  error: string | null
}
