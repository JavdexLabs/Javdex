export type LocalModelId = 'kotoba' | 'qwen3'
export type LocalTranslationMode = 'app-default' | 'local'
export type LocalModelCommand =
  | { action: 'download'; model: LocalModelId }
  | { action: 'delete'; model: LocalModelId }
  | { action: 'export'; model: LocalModelId }
  | { action: 'cancel-download' }
  | { action: 'choose-location' }
  | { action: 'reset-location' }
  | { action: 'translation'; mode: LocalTranslationMode }
export interface LocalModelView {
  id: LocalModelId
  name: string
  purpose: string
  bytes: number
  installed: boolean
  inUse: boolean
}
export interface LocalModelSnapshot {
  supported: boolean
  directory: string
  defaultDirectory: string
  translation: LocalTranslationMode
  models: LocalModelView[]
  operation: 'download' | 'delete' | 'export' | 'relocate' | 'configure' | null
  activeModel: LocalModelId | null
  downloadBytes: number
  downloadTotal: number
  downloadLabel: string | null
  error: string | null
}
