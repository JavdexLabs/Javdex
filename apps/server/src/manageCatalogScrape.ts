import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ManageOperationId } from '@shared/manage/operations'
import type { VideoScrapeField, VideoScrapeUpdateMode } from '@shared/videoScrapeTypes'
import type { PendingVideoScrapeConfirmInput } from '@shared/videoScrapeTypes'
import { structuredError, isStructuredError } from '@shared/protocol/errors'
import { getPendingVideoScrapeResolutionSnapshot } from '@library/db/pendingVideoScrapeRepo'
import { confirmPendingVideoScrape } from '@library/catalog/catalogPendingVideoScrapes'
import { applyActressScrapeCandidate, applyVideoScrapeCandidate, replacePendingVideoScrapeFromUploads, submitActressScrapeConflict } from '@library/catalog/catalogScrapeApply'
import { applyPlaylistImport } from '@library/catalog/catalogPlaylistImport'
import { createCatalogTargetList, pageCatalogTargetList } from '@library/catalog/catalogTargetLists'
import {
  applyAgentMetadataDraft,
  discardAgentMetadataDraft,
  findReadyAgentMetadata
} from '@library/catalog/catalogAgentMetadata'
import {
  assertExpectedVideoVersion,
  bumpRowRevision,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'
import { commitManageImageMutation } from '@library/catalog/catalogImageApply'
import {
  commit,
  requireLibraryRevision,
  requireMutation,
  type CatalogHandler,
  type HandlerArgs
} from './manageCatalogHandlers'

function mapDomainError(error: unknown): never {
  if (isStructuredError(error)) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('已变化') || message.includes('已过期') || message.includes('版本')) {
    throw structuredError('VERSION_CONFLICT', message)
  }
  throw structuredError('INVALID_INPUT', message)
}

function runDomain<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    return mapDomainError(error)
  }
}

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
    const input = args.envelope.input as PendingVideoScrapeConfirmInput
    const mutation = requireMutation(args.envelope)
    const expectedRevision = requireQRevision(args)
    return commitImage(args, () =>
      runDomain(() => {
        const snapshot = getPendingVideoScrapeResolutionSnapshot(input.pendingScrapeId)
        if (!snapshot) throw new Error('待确认影片刮削结果不存在')
        assertExpectedVideoVersion(
          snapshot.pending.videoId,
          mutation.expectedVersions,
          mutation.operationId,
          args.database
        )
        const result = confirmPendingVideoScrape(input, { expectedRevision })
        const videoId = input.mergeRetainedVideoId ?? snapshot.pending.videoId
        if (result.applied) bumpRowRevision('videos', videoId, args.database)
        return {
          ...result,
          versions: { V: readVideoAggregateVersion(videoId, args.database) }
        }
      })
    )
  },
  'videos.applyScrapeCandidate'(args) {
    const input = args.envelope.input as {
      videoId: number
      fields: VideoScrapeField[]
      mode: VideoScrapeUpdateMode
      candidate: unknown
      cover?: CatalogImageRef
      samples?: CatalogImageRef[]
      actressAvatars?: Array<{ name: string; image: CatalogImageRef }>
      directorSelectionId?: number
      directorAmbiguity?: 'choice' | 'preserve'
    }
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      applyVideoScrapeCandidate({
        ...input,
        expected: mutation.expectedVersions,
        operationId: mutation.operationId,
        database: args.database
      })
    )
  },
  'pendingVideoScrapes.replace'(args) {
    const input = args.envelope.input as Parameters<typeof replacePendingVideoScrapeFromUploads>[0]
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      replacePendingVideoScrapeFromUploads({
        ...input,
        expected: mutation.expectedVersions,
        operationId: mutation.operationId,
        database: args.database
      })
    )
  },
  'actresses.applyScrapeCandidate'(args) {
    const input = args.envelope.input as {
      actressId: number
      candidate: unknown
      avatar?: CatalogImageRef
      gallery?: CatalogImageRef[]
      fields?: import('@shared/actressScrapeTypes').ActressScrapeField[]
      mode?: import('@shared/actressScrapeTypes').ActressScrapeUpdateMode
    }
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      applyActressScrapeCandidate({
        ...input,
        expected: mutation.expectedVersions,
        operationId: mutation.operationId,
        database: args.database
      })
    )
  },
  'actressConflicts.submit'(args) {
    const input = args.envelope.input as Parameters<typeof submitActressScrapeConflict>[0]
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      submitActressScrapeConflict({
        ...input,
        expected: mutation.expectedVersions,
        operationId: mutation.operationId,
        database: args.database
      })
    )
  },
  'playlists.applyImport'(args) {
    const input = args.envelope.input as {
      name: string
      videoIds: number[]
      libraryId: number
      cover?: CatalogImageRef
      sourceUrl?: string
      videoLinks?: Array<{ videoId: number; label: string; url: string }>
    }
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
  'targetLists.page'(args) {
    const input = args.envelope.input as { targetListId: string; limit?: number; offset?: number }
    return pageCatalogTargetList(input, args.database)
  },
  'agentMetadata.findReady'(args) {
    const input = args.envelope.input as { target: { kind: 'video' | 'actress'; id: number } }
    return findReadyAgentMetadata(input.target, args.database)
  },
  'agentMetadata.apply'(args) {
    const input = args.envelope.input as {
      draftId: string
      reviewToken: string
      uploads?: CatalogImageRef[]
    }
    const mutation = requireMutation(args.envelope)
    return commitImage(args, () =>
      applyAgentMetadataDraft({
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
