import { confirmPendingVideoScrapeCommand, applyVideoScrapeCommand, replacePendingVideoScrapeCommand, applyActressScrapeCommand, submitActressScrapeConflictCommand } from '@library/catalog/catalogScrapeCommands'
import { resolveCatalogScrapeFields } from '@library/catalog/catalogScrapeFields'
import type { ManageOperationInput } from '@shared/manage/inputs'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ManageOperationId } from '@shared/manage/operations'
import { structuredError } from '@shared/protocol/errors'
import { applyPlaylistImport } from '@library/catalog/catalogPlaylistImport'
import { countCatalogTargets, createCatalogTargetList, pageCatalogTargetList } from '@library/catalog/catalogTargetLists'
import {
  applyTransferredAgentMetadataCandidate,
  applyAgentMetadataDraft,
  discardAgentMetadataDraft,
  findReadyAgentMetadata
} from '@library/catalog/catalogAgentMetadata'
import {
  buildAgentMetadataReview
} from '@library/catalog/catalogAgentMetadataReview'
import type {
  AgentMetadataApplyTransfer,
  AgentMetadataPreviewTransferInput
} from '@shared/agentMetadataTypes'
import { commitManageImageMutation } from '@library/catalog/catalogImageApply'
import {
  commit,
  requireLibraryRevision,
  requireMutation,
  type CatalogHandler,
  type HandlerArgs
} from './manageCatalogHandlers'

function requireQRevision(args: HandlerArgs): number {
  const mutation = requireMutation(args.envelope)
  const version = mutation.expectedVersions.Q
  if (!version) {
    throw structuredError(
      'INVALID_INPUT',
      '待确认操作需要 Q 版本',
      { field: 'expectedVersions.Q' },
      mutation.operationId
    )
  }
  return version.revision
}

function commitImage<T>(args: HandlerArgs, work: () => T): unknown {
  const mutation = requireMutation(args.envelope)
  const result = commitManageImageMutation(
    {
      operationId: mutation.operationId,
      operation: args.operation,
      expectedVersions: mutation.expectedVersions,
      input: args.envelope.input,
      writerEpoch: args.auth.epoch
    },
    work,
    args.database
  )
  if (typeof result.data === 'boolean') return { receipt: result.receipt, ok: result.data }
  if (typeof result.data === 'number') return { receipt: result.receipt, id: result.data }
  if (result.data && typeof result.data === 'object') return { receipt: result.receipt, ...result.data }
  return { receipt: result.receipt, data: result.data }
}

export const scrapeHandlers: Partial<Record<ManageOperationId, CatalogHandler>> = {
  'pendingVideoScrapes.confirm'(args) {
    const mutation = requireMutation(args.envelope)
    const result = confirmPendingVideoScrapeCommand(args.envelope.input as Parameters<typeof confirmPendingVideoScrapeCommand>[0], { ...mutation, writerEpoch: args.auth.epoch, database: args.database })
    return { receipt: result.receipt, ...result.data }
  },
  'videos.applyScrapeCandidate'(args) {
    const mutation = requireMutation(args.envelope)
    const result = applyVideoScrapeCommand(args.envelope.input as Parameters<typeof applyVideoScrapeCommand>[0], { ...mutation, writerEpoch: args.auth.epoch, database: args.database })
    return { receipt: result.receipt, ...result.data }
  },
  'pendingVideoScrapes.replace'(args) {
    const mutation = requireMutation(args.envelope)
    const result = replacePendingVideoScrapeCommand(args.envelope.input as Parameters<typeof replacePendingVideoScrapeCommand>[0], { ...mutation, writerEpoch: args.auth.epoch, database: args.database })
    return { receipt: result.receipt, ...result.data }
  },
  'actresses.applyScrapeCandidate'(args) {
    const mutation = requireMutation(args.envelope)
    const result = applyActressScrapeCommand(args.envelope.input as Parameters<typeof applyActressScrapeCommand>[0], { ...mutation, writerEpoch: args.auth.epoch, database: args.database })
    return { receipt: result.receipt, ...result.data }
  },
  'actressConflicts.submit'(args) {
    const mutation = requireMutation(args.envelope)
    const result = submitActressScrapeConflictCommand(args.envelope.input as Parameters<typeof submitActressScrapeConflictCommand>[0], { ...mutation, writerEpoch: args.auth.epoch, database: args.database })
    return { receipt: result.receipt, ...result.data }
  },
  'playlists.applyImport'(args) {
    const input = args.envelope.input as ManageOperationInput<'playlists.applyImport'>
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      applyPlaylistImport({
        ...input,
        expected: mutation.expectedVersions,
        operationId: mutation.operationId,
        expectedLibraryRevision: requireLibraryRevision(
          mutation.expectedVersions,
          'L',
          mutation.operationId
        ),
        database: args.database
      })
    )
  },
  'targetLists.create'(args) {
    const input = args.envelope.input as import('@shared/protocol/tasks').TargetListCreateInput
    return commit(args, () => createCatalogTargetList(input, args.database))
  },
  'targetLists.count'(args) {
    return countCatalogTargets(args.envelope.input as ManageOperationInput<'targetLists.count'>, args.database)
  },
  'scrape.fields'(args) {
    return resolveCatalogScrapeFields(args.envelope.input as ManageOperationInput<'scrape.fields'>)
  },
  'targetLists.page'(args) {
    const input = args.envelope.input as { targetListId: string; limit?: number; offset?: number }
    return pageCatalogTargetList(input, args.database)
  },
  'agentMetadata.findReady'(args) {
    const input = args.envelope.input as { target: { kind: 'video' | 'actress'; id: number } }
    return findReadyAgentMetadata(input.target, args.database)
  },
  'agentMetadata.preview'(args) {
    const input = args.envelope.input as AgentMetadataPreviewTransferInput
    const review = buildAgentMetadataReview(
      input.candidate,
      input.selection,
      input.reviewRevision ?? input.candidate.revision + 1,
      { includeVersions: true }
    )
    return {
      review,
      versions: review.previewVersions!
    }
  },
  'agentMetadata.apply'(args) {
    const input = args.envelope.input as {
      draftId: string
      reviewToken: string
      uploads?: CatalogImageRef[]
      transfer?: AgentMetadataApplyTransfer
    }
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      input.transfer
        ? applyTransferredAgentMetadataCandidate({
            transfer: input.transfer,
            reviewToken: input.reviewToken,
            expected: mutation.expectedVersions,
            operationId: mutation.operationId,
            database: args.database
          })
        : applyAgentMetadataDraft({
            ...input,
            expected: mutation.expectedVersions,
            operationId: mutation.operationId,
            database: args.database
          })
    )
  },
  'agentMetadata.discard'(args) {
    const input = args.envelope.input as { draftId: string }
    return commit(args, () =>
      discardAgentMetadataDraft(input.draftId, requireQRevision(args), args.database)
    )
  }
}
