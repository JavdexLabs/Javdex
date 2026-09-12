import { randomUUID } from 'node:crypto'
import type { MutationContext } from './catalogBackend'
import type { ExpectedVersions } from '@shared/protocol/versions'

export function ipcMutation(
  operationId?: string,
  expectedVersions: ExpectedVersions = {}
): MutationContext {
  return {
    operationId: operationId ?? randomUUID(),
    expectedVersions
  }
}
