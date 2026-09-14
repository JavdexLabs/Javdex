export const CATALOG_TASK_STATES = [
  'queued',
  'running',
  'cancelRequested',
  'succeeded',
  'failed',
  'cancelled',
  'needsInspection'
] as const

export type CatalogTaskState = (typeof CATALOG_TASK_STATES)[number]

export type TaskOwner = 'desktop' | 'catalog'

export interface CatalogTaskSnapshot {
  owner: TaskOwner
  taskId: string
  operationId?: string
  catalogId: string
  libraryId?: number
  kind: string
  state: CatalogTaskState
  taskRevision: number
  progressSeq: number
  label?: string
  counts?: Record<string, number>
  errorCode?: string
}

export interface TaskCancelInput {
  taskId: string
}

export interface TargetListCreateInput {
  kind: string
  filterDigest: string
  ids?: number[]
  videoFilter?: {
    libraryId?: number
    status?: 0 | 1 | 2 | 'all'
    missingFields?: string[]
    sourceName?: string
    ratingSourceName?: string
  }
  actressFilter?: {
    scope?: 'all' | 'female' | 'male'
    scrapeStatus?: 'all' | 'unscraped' | 'success' | 'failed'
    missingFields?: string[]
  }
}

export interface TargetListEntry {
  id: number
  present: boolean
  label?: string | null
  revision?: number | null
}

export interface TargetListPage {
  targetListId: string
  ids: number[]
  offset: number
  hasMore: boolean
  entries: TargetListEntry[]
}
