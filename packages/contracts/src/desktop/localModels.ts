export const LOCAL_TRANSLATION_MODEL_IDS = ['qwen3', 'hy-mt2-7b', 'index-translate-9b'] as const
export const LOCAL_MODEL_IDS = ['qwen3', 'kotoba', 'hy-mt2-7b', 'index-translate-9b'] as const
export type LocalTranslationModelId = typeof LOCAL_TRANSLATION_MODEL_IDS[number]
export type LocalModelId = typeof LOCAL_MODEL_IDS[number]
export const LOCAL_MODEL_DOWNLOAD_SOURCES = ['official', 'hf-mirror'] as const
export type LocalModelDownloadSource = typeof LOCAL_MODEL_DOWNLOAD_SOURCES[number]
export type LocalTranslationMode = 'app-default' | 'local'
export interface LocalModelRef { model: LocalModelId; variant: string }
export interface LocalModelUsage {
  subtitleRecognition: LocalModelRef & { model: 'kotoba' }
  subtitleTranslation: LocalModelRef & { model: LocalTranslationModelId }
  textTranslation: LocalModelRef & { model: LocalTranslationModelId; mode: LocalTranslationMode }
}
export type LocalModelReadiness = 'ready' | 'missing-model' | 'missing-runtime' | 'unsupported'
export type LocalModelCommand =
  | { action: 'download' | 'delete' | 'export' | 'import' | 'copy-download-url'; model: LocalModelId; variant?: string }
  | { action: 'select'; model: LocalModelId; variant: string }
  | { action: 'download-source'; source: LocalModelDownloadSource }
  | { action: 'cancel-download' }
  | { action: 'choose-location' }
  | { action: 'reset-location' }
  | { action: 'translation'; mode: LocalTranslationMode }
  | { action: 'translation-model'; model: LocalTranslationModelId }
  | { action: 'usage'; usage: LocalModelUsage; expectedRevision?: string }
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
  references: string[]
  ready: boolean
  readiness: LocalModelReadiness
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
  revision: string
  usage: LocalModelUsage
  downloadSource: LocalModelDownloadSource
  supported: boolean
  directory: string
  defaultDirectory: string
  translation: LocalTranslationMode
  translationModel: LocalTranslationModelId
  models: LocalModelView[]
  operation: 'import' | 'download' | 'delete' | 'export' | 'relocate' | 'configure' | null
  activeModel: LocalModelId | null
  activeVariant: string | null
  downloadBytes: number
  downloadTotal: number
  downloadLabel: string | null
  error: string | null
  /** Invalid persisted configuration; saving valid usage bindings explicitly recovers it. */
  configurationError?: string | null
}
