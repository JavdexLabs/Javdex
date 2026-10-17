/** No model paths, source locators, local inference credentials or transcript text cross IPC. */
export type AiSubtitleDisplay = 'bilingual' | 'chinese' | 'japanese'
export type AiSubtitleCommand =
  | { action: 'start' | 'stop' | 'retry' | 'clear-cache' | 'export' | 'view-log' }
  | { action: 'display'; value: AiSubtitleDisplay }
  | { action: 'font-size'; value: number }
export interface AiSubtitleSnapshot {
  sessionId: string | null
  supported: boolean
  installed: boolean
  enabled: boolean
  phase: 'idle' | 'preparing' | 'recognizing' | 'translating' | 'ready' | 'error'
  activeStart: number | null
  recognizedSeconds: number
  translatedSeconds: number
  /** Absolute video endpoints of continuous coverage from the current playback chunk; null while that range is pending. */
  recognizedUntil: number | null
  translatedUntil: number | null
  duration: number | null
  display: AiSubtitleDisplay
  fontSize: number
  error: string | null
}
