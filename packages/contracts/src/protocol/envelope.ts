import type { ExpectedVersions } from './versions'

export interface ManageAuthContext {
  serverId: string
  catalogId: string
  writerEpoch?: number
}

export interface ManageQueryEnvelope<TInput> extends ManageAuthContext {
  input: TInput
}

export interface ManageMutationEnvelope<TInput> extends ManageAuthContext {
  operationId: string
  writerEpoch: number
  expectedVersions: ExpectedVersions
  input: TInput
}

export interface ManagePlanEnvelope<TInput> extends ManageMutationEnvelope<TInput> {
  planId: string
  planDigest: string
}

export interface QueryPageMeta {
  pageSize: number
  offset: number
  total: number
  hasMore: boolean
  viewRevision: string
  stale: boolean
}

export interface ManageQueryResult<T> {
  serverId: string
  catalogId: string
  data: T
  page?: QueryPageMeta
}

export type MutationOutcomeKind = 'applied' | 'duplicate' | 'acceptedTask'

export interface ManageMutationResult<T> {
  operationId: string
  outcome: MutationOutcomeKind
  serverId: string
  catalogId: string
  writerEpoch: number
  data: T
  taskId?: string
}
