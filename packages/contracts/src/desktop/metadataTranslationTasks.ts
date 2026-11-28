import { z } from 'zod'
import { translationFieldSchema, translationTextSchema, type MetadataTranslationField } from '../metadataTranslation'

export const TRANSLATION_BATCH_MAX_VIDEOS = 5000
export const TRANSLATION_PAGE_SIZE = 20
export const translationReviewFilterSchema = z.enum(['active', 'attention', 'finished'])
export const translationBulkOperationSchema = z.enum(['resume', 'pause', 'remove-active', 'clear-completed'])
const id = z.uuid()
const modelToken = z.string().regex(/^[a-f0-9]{64}$/)
const videoId = z.number().int().positive()
const filmRef = z.object({ taskId: id, videoId }).strict()
export const translationDraftRefSchema = z.object({ id, revision: z.number().int().positive(), videoId }).strict()
export const translationStartSchema = z.object({
  libraryId: videoId,
  videoIds: z.array(videoId).min(1).max(TRANSLATION_BATCH_MAX_VIDEOS),
  fields: z.array(translationFieldSchema).min(1).max(2),
  directApply: z.boolean(),
  modelToken
}).strict()
export const translationTaskCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bulk'), operation: translationBulkOperationSchema, films: z.array(filmRef).min(1) }).strict(),
  z.object({ action: z.enum(['pause', 'continue', 'retry-apply']), taskId: id, videoId }).strict(),
  z.object({ action: z.literal('change-model'), taskId: id, videoId, modelToken }).strict(),
  z.object({ action: z.enum(['discard', 'retry', 'retranslate']), taskId: id, item: translationDraftRefSchema }).strict(),
  z.object({ action: z.literal('edit'), taskId: id, item: translationDraftRefSchema, translation: translationTextSchema }).strict(),
  z.object({ action: z.enum(['apply', 'discard-selected']), items: z.array(translationDraftRefSchema).min(1) }).strict()
])

export type TranslationStart = z.infer<typeof translationStartSchema>
export type TranslationTaskCommand = z.infer<typeof translationTaskCommandSchema>
export type TranslationDraftRef = z.infer<typeof translationDraftRefSchema>
export type TranslationReviewFilter = z.infer<typeof translationReviewFilterSchema>
export type TranslationBulkOperation = z.infer<typeof translationBulkOperationSchema>
export type TranslationFilmRef = z.infer<typeof filmRef>
export type TranslationFieldStatus = 'queued' | 'running' | 'review' | 'failed' | 'conflict' | 'blocked' | 'moved' | 'missing' | 'applying' | 'applied' | 'skipped' | 'discarded'
export const discardableTranslationStatuses: readonly TranslationFieldStatus[] = ['review', 'failed', 'conflict', 'blocked', 'moved', 'missing']
export type TranslationFieldSelection = TranslationDraftRef & { status: TranslationFieldStatus }

export interface TranslationModelView { name: string; location: 'local-model' | 'local-service' | 'cloud'; token: string }
export interface TranslationStartResult { taskId: string | null; duplicates: number; unavailable: number }
export interface TranslationOverview { total: number; running: number; attention: number }
export interface TranslationVideoView {
  taskId: string
  videoId: number
  code: string
  fields: TranslationFieldView[]
  libraryName: string
  createdAt: string
  modelName: string
  directApply: boolean
  paused: boolean
  message: string | null
  hasWork: boolean
  running: boolean
  uncertain: boolean
}
export interface TranslationFieldView extends TranslationDraftRef {
  field: MetadataTranslationField
  status: TranslationFieldStatus
  message: string | null
  original: string | null
  translation: string | null
  previousStatus: TranslationFieldStatus | null
  currentOriginal?: string | null
}
export interface TranslationTaskPage {
  items: TranslationVideoView[]
  total: number
  counts: Record<TranslationReviewFilter, number>
  selectableFields: number
  bulkCounts: Record<TranslationBulkOperation, number>
}
