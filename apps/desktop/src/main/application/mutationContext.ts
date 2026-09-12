import { randomUUID } from 'node:crypto'
import type { MutationContext } from './catalogBackend'

export function ipcMutation(operationId?: string): MutationContext {
  return {
    operationId: operationId ?? randomUUID(),
    expectedVersions: {}
  }
}
