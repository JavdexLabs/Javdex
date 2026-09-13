import type { StructuredError } from './protocol/errors'

// ---- Generic IPC response wrapper ----

export interface IpcResponse<T> {
  ok: boolean
  data?: T
  error?: StructuredError
}
