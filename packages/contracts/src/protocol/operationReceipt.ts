import type { ExpectedVersions } from './versions'

export type OperationReceiptStatus =
  | 'applied'
  | 'duplicate'
  | 'acceptedTask'
  | 'rejected'
  | 'unknown'

export interface OperationReceipt {
  operationId: string
  status: OperationReceiptStatus
  digest: string
  entityIds?: Array<number | string>
  counts?: Record<string, number>
  versions?: ExpectedVersions
  errorCode?: string
  taskId?: string
  createdAt: string
}

export interface OperationDigestFields {
  operation: string
  expectedVersions: ExpectedVersions
  input: unknown
  uploadIds?: string[]
}
