export const MANAGE_ERROR_CODES = [
  'VERSION_CONFLICT',
  'IDENTITY_CONFLICT',
  'WRITER_REVOKED',
  'AUTH_REQUIRED',
  'INSTANCE_MISMATCH',
  'CATALOG_MISMATCH',
  'VERSION_MISMATCH',
  'OPERATION_KEY_REUSED',
  'PLAN_EXPIRED',
  'PLAN_STALE',
  'ROOT_OFFLINE',
  'READ_ONLY_MOUNT',
  'FILE_CHANGED',
  'CATALOG_FROZEN',
  'MAINTENANCE_BUSY',
  'UPLOAD_NOT_READY',
  'UPLOAD_EXPIRED',
  'RECOVERY_REQUIRED',
  'INVALID_INPUT',
  'LIMIT_EXCEEDED',
  'UNSUPPORTED_CAPABILITY',
  'BROWSER_AUTH_REJECTED',
  'MODE_PREP_REQUIRED',
  'CONNECTION_UNAVAILABLE'
] as const

export type ManageErrorCode = (typeof MANAGE_ERROR_CODES)[number]

export const RECOVERY_ACTIONS = [
  'refreshAndConfirm',
  'rebindWriter',
  'showMismatch',
  'regeneratePlan',
  'showRootIssue',
  'waitFrozen',
  'reuploadThenRetry',
  'inspectReceipt',
  'correctInput',
  'returnToLocalPrep',
  'retryConnection',
  'none'
] as const

export type RecoveryActionType = (typeof RECOVERY_ACTIONS)[number]

export const ERROR_CODE_RECOVERY: Record<ManageErrorCode, RecoveryActionType> = {
  VERSION_CONFLICT: 'refreshAndConfirm',
  IDENTITY_CONFLICT: 'refreshAndConfirm',
  WRITER_REVOKED: 'rebindWriter',
  AUTH_REQUIRED: 'rebindWriter',
  INSTANCE_MISMATCH: 'showMismatch',
  CATALOG_MISMATCH: 'showMismatch',
  VERSION_MISMATCH: 'showMismatch',
  OPERATION_KEY_REUSED: 'inspectReceipt',
  PLAN_EXPIRED: 'regeneratePlan',
  PLAN_STALE: 'regeneratePlan',
  ROOT_OFFLINE: 'showRootIssue',
  READ_ONLY_MOUNT: 'showRootIssue',
  FILE_CHANGED: 'showRootIssue',
  CATALOG_FROZEN: 'waitFrozen',
  MAINTENANCE_BUSY: 'waitFrozen',
  UPLOAD_NOT_READY: 'reuploadThenRetry',
  UPLOAD_EXPIRED: 'reuploadThenRetry',
  RECOVERY_REQUIRED: 'inspectReceipt',
  INVALID_INPUT: 'correctInput',
  LIMIT_EXCEEDED: 'correctInput',
  UNSUPPORTED_CAPABILITY: 'none',
  BROWSER_AUTH_REJECTED: 'none',
  MODE_PREP_REQUIRED: 'returnToLocalPrep',
  CONNECTION_UNAVAILABLE: 'retryConnection'
}
