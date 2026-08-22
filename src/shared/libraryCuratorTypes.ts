export interface LibraryCuratorStartInput {
  prompt?: string
}

export interface LibraryCuratorMessageInput {
  runId: string
  text: string
}

export interface LibraryCuratorResult {
  runId: string
  status: 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled'
  summary: string
  totalTokens: number
}

export interface LibraryCuratorSnapshot extends LibraryCuratorResult {
  cursor: number
}
