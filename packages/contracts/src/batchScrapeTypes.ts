export interface BatchProgress {
  total: number
  current: number
  success: number
  pending: number
  failed: number
  currentCode: string | null
  status: 'idle' | 'running' | 'paused' | 'done' | 'cancelled'
  logs: BatchLogEntry[]
}

export interface BatchScrapeState {
  kind: 'video' | 'actress' | null
  progress: BatchProgress | null
  recoverable: boolean
  unrecoverableReason?: string
}

export interface BatchLogEntry {
  time: string
  code: string
  level: 'info' | 'success' | 'error'
  message: string
}
