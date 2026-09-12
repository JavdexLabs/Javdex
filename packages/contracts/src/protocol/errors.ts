import type { ManageErrorCode, RecoveryActionType } from './errorCodes'
import { ERROR_CODE_RECOVERY } from './errorCodes'

export interface ControlledErrorDetails {
  field?: string
  limit?: number
  actual?: number
  entityKind?: string
  entityId?: number | string
  conflictingId?: number | string
  planId?: string
  taskId?: string
  operationId?: string
}

export interface StructuredError {
  code: ManageErrorCode
  message: string
  details?: ControlledErrorDetails
  operationId?: string
  recovery: RecoveryActionType
}

export function structuredError(
  code: ManageErrorCode,
  message: string,
  details?: ControlledErrorDetails,
  operationId?: string
): StructuredError {
  return {
    code,
    message,
    details,
    operationId,
    recovery: ERROR_CODE_RECOVERY[code]
  }
}

export function isStructuredError(value: unknown): value is StructuredError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'recovery' in value &&
    typeof (value as StructuredError).code === 'string' &&
    typeof (value as StructuredError).message === 'string'
  )
}
