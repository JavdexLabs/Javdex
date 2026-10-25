export const LOCAL_TRANSLATION_MODEL_IDS = ['qwen3', 'hy-mt2-7b'] as const
export const LOCAL_RECOGNITION_MODEL_IDS = ['kotoba', 'qwen3-asr'] as const
export type LocalRecognitionModelId = typeof LOCAL_RECOGNITION_MODEL_IDS[number]
export const isSpeechModel = (model: string): model is LocalRecognitionModelId => (LOCAL_RECOGNITION_MODEL_IDS as readonly string[]).includes(model)
export const LOCAL_MODEL_IDS = ['qwen3', 'kotoba', 'hy-mt2-7b', 'qwen3-asr'] as const
export type LocalTranslationModelId = typeof LOCAL_TRANSLATION_MODEL_IDS[number]
export type LocalModelId = typeof LOCAL_MODEL_IDS[number]
export const LOCAL_MODEL_DOWNLOAD_SOURCES = ['official', 'hf-mirror'] as const
export type LocalModelDownloadSource = typeof LOCAL_MODEL_DOWNLOAD_SOURCES[number]
export type LocalTranslationMode = 'app-default' | 'local'
export interface LocalAccelerationPolicy { mode: 'auto' | 'cpu' | 'gpu'; device?: string }
export interface LocalGpuDevice { id: string; name: string; backend: 'cuda' | 'vulkan'; index: number; memoryMiB: number; integrated?: boolean; audioCppOnly?: boolean }
export interface LocalExecutionStatus {
  backend: 'cpu' | 'cuda' | 'vulkan' | 'metal' | 'idle'
  device?: string
  reason?: string
}
export interface LocalModelValidation {
  state: 'waiting' | 'checking' | 'passed' | 'failed'
  execution?: LocalExecutionStatus
  checkedAt?: string
  message?: string
}
export interface LocalAccelerationSnapshot {
  supported: boolean
  policy: LocalAccelerationPolicy
  devices: LocalGpuDevice[]
  recognition: LocalExecutionStatus
  translation: LocalExecutionStatus
  error: string | null
  /** False when Vulkan enumeration still needs its probe component. */
  detectionComplete?: boolean
}
export const LOCAL_MODEL_GROUPS = ['speech', 'qwen-speech', 'text'] as const
export type LocalModelGroup = typeof LOCAL_MODEL_GROUPS[number]
export const localModelGroup = (model: LocalModelId): LocalModelGroup => model === 'qwen3-asr' ? 'qwen-speech' : model === 'kotoba' ? 'speech' : 'text'
export const localModelGroupLabel = (group: LocalModelGroup): string => group === 'qwen-speech' ? '语音模型-ASR' : group === 'speech' ? '语音模型-Whisper' : '文本'
export interface LocalRuntimeComponent {
  /** False when an optional component is disabled but retained for file management. */
  enabled?: boolean
  /** Includes incomplete downloads and damaged installations that can be removed. */
  hasFiles?: boolean
  id: string
  group: LocalModelGroup
  name: string
  version: string
  backend: 'cpu' | 'common' | 'cuda' | 'vulkan'
  delivery: 'download' | 'bundled'
  bytes: number
  installed: boolean
  source: string
}
export interface LocalPreparationItem {
  id: string
  name: string
  group: LocalModelGroup
  action: 'reuse' | 'download' | 'install' | 'verify'
  bytes: number
  downloadBytes: number
  source: string
}
export interface LocalPreparationPlan {
  items: LocalPreparationItem[]
  downloadBytes: number
  backend: 'cpu' | 'cuda' | 'vulkan' | 'metal'
}
export interface LocalRuntimeEnvironment {
  group: LocalModelGroup
  supported?: boolean
  components: LocalRuntimeComponent[]
  cpuReady: boolean
  gpu: { state: 'ready' | 'missing' | 'unavailable' | 'unchecked' | 'disabled' | 'platform'; backend?: 'cuda' | 'vulkan' | 'metal' }
  preparation: LocalPreparationPlan
  gpuPreparation: LocalPreparationPlan
}
export interface LocalDependencyCheck {
  state: 'checking' | 'ready' | 'missing' | 'cpu-fallback' | 'unsupported'
  missing: string[]
  backend: LocalPreparationPlan['backend']
  message: string
}
export interface LocalModelRef { model: LocalModelId; variant: string }
export interface LocalModelUsage {
  subtitleRecognition: LocalModelRef & { model: LocalRecognitionModelId }
  subtitleTranslation: LocalModelRef & { model: LocalTranslationModelId }
  textTranslation: LocalModelRef & { model: LocalTranslationModelId; mode: LocalTranslationMode }
}
export type LocalModelReadiness = 'ready' | 'missing-model' | 'missing-runtime' | 'unsupported'
export type LocalModelCommand =
  | { action: 'qwen-forced-aligner'; enabled: boolean; expectedRevision?: string }
  | { action: 'acceleration'; policy: LocalAccelerationPolicy; expectedRevision?: string }
  | { action: 'detect-devices' }
  | { action: 'prepare-acceleration'; model?: LocalModelId; variant?: string }
  | { action: 'prepare-runtime'; group: LocalModelGroup; target: 'auto' | 'cpu' | 'gpu' }
  | { action: 'delete-runtime'; group: LocalModelGroup; target: 'cpu' | 'gpu' }
  | { action: 'download' | 'delete' | 'export' | 'import' | 'copy-download-url'; model: LocalModelId; variant?: string }
  | { action: 'select'; model: LocalModelId; variant: string }
  | { action: 'download-source'; source: LocalModelDownloadSource }
  | { action: 'cancel-download' | 'clean-downloads' | 'clear-cache' }
  | { action: 'choose-location' | 'open-location' | 'refresh-storage' }
  | { action: 'reset-location' }
  | { action: 'translation'; mode: LocalTranslationMode }
  | { action: 'translation-model'; model: LocalTranslationModelId }
  | { action: 'usage'; usage: LocalModelUsage; expectedRevision?: string }
export interface LocalModelVariantView {
  /** Includes incomplete downloads and damaged model files. */
  hasFiles?: boolean
  id: string
  precision: string
  format: 'GGML' | 'GGUF' | 'Safetensors'
  bytes: number
  installed: boolean
  inUse: boolean
  recommended: boolean
  source: string
  publisher: string
  references: string[]
  ready: boolean
  readiness: LocalModelReadiness
  /** Shared CPU engine and auxiliary files, independent of this variant's weights. */
  runtimeReady?: boolean
  dependencies?: LocalDependencyCheck
  /** Only this precision's model file; environment installation is a separate operation. */
  preparation?: LocalPreparationPlan
  validation?: LocalModelValidation
  /** Last reported execution for this exact variant; active only while inUse. */
  execution?: LocalExecutionStatus
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
  /** Missing in older snapshots means enabled. */
  qwenForcedAligner?: boolean
  /** Last asynchronous failure retains its exact retry target after the task ends. */
  operationError?: { message: string; command: LocalModelCommand }
  /** Actual regular-file bytes, measured on refresh; links are never followed. */
  storage?: { models: LocalFileUsage; runtimes: LocalFileUsage; downloads: LocalFileUsage; staging: LocalFileUsage; cache: LocalFileUsage; checkedAt: string }
  acceleration?: LocalAccelerationSnapshot
  revision: string
  usage: LocalModelUsage
  downloadSource: LocalModelDownloadSource
  supported: boolean
  directory: string
  defaultDirectory: string
  translation: LocalTranslationMode
  translationModel: LocalTranslationModelId
  models: LocalModelView[]
  operation: 'import' | 'download' | 'delete' | 'export' | 'relocate' | 'configure' | 'cleanup' | null
  activeModel: LocalModelId | null
  activeVariant: string | null
  downloadBytes: number
  downloadTotal: number
  downloadLabel: string | null
  downloadKind?: 'model' | 'acceleration'
  environments?: LocalRuntimeEnvironment[]
  checkingDependencies?: boolean
  preparation?: { plan: LocalPreparationPlan; phase: 'checking' | 'downloading' | 'installing'; itemId: string; completedItems: number }
  error: string | null
  /** Invalid persisted configuration; saving valid usage bindings explicitly recovers it. */
  configurationError?: string | null
}
export interface LocalFileUsage { bytes: number; files: number }
