/** No model paths, source locators, local inference credentials or transcript text cross IPC. */
export type AiSubtitleDisplay = 'bilingual' | 'chinese' | 'japanese'
export type AiSubtitleCommand =
  | { action: 'start' | 'stop' | 'retry' | 'clear-cache' | 'export' }
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
  duration: number | null
  display: AiSubtitleDisplay
  fontSize: number
  error: string | null
}
