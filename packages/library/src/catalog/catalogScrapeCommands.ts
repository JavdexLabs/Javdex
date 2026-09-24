import type Database from 'better-sqlite3'
import type { CatalogWriteContext } from './catalogOperations'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { PendingVideoScrapeConfirmInput } from '@shared/videoScrapeTypes'
import { structuredError } from '@shared/protocol/errors'
import { getPendingVideoScrapeResolutionSnapshot } from '@library/db/pendingVideoScrapeRepo'
import { commitManageImageMutation } from './catalogImageApply'
import {
  assertExpectedVideoVersion,
  bumpRowRevision,
  readVideoAggregateVersion
} from './catalogAggregateVersion'
import { confirmPendingVideoScrape } from './catalogPendingVideoScrapes'
import {
  applyVideoScrapeCandidate,
  applyActressScrapeCandidate,
  replacePendingVideoScrapeFromUploads,
  submitActressScrapeConflict
} from './catalogScrapeApply'

type ScrapeInput<T> = Omit<T, 'expected' | 'operationId' | 'database'>

/** Own the receipt and image transaction together; adapters only unwrap the result. */
function scrapeCommand<I, O>(operation: string, apply: (input: I & {
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}) => O): (input: I, context: CatalogWriteContext) => ReturnType<typeof commitManageImageMutation<O>> {
  return (input, context) => commitManageImageMutation(
    { ...context, operation, input },
    () => apply({
      ...input,
      expected: context.expectedVersions,
      operationId: context.operationId,
      database: context.database
    }),
    context.database
  )
}

export const applyVideoScrapeCommand = scrapeCommand<
  ScrapeInput<Parameters<typeof applyVideoScrapeCandidate>[0]>,
  ReturnType<typeof applyVideoScrapeCandidate>
>('videos.applyScrapeCandidate', applyVideoScrapeCandidate)

export const applyActressScrapeCommand = scrapeCommand<
  ScrapeInput<Parameters<typeof applyActressScrapeCandidate>[0]>,
  ReturnType<typeof applyActressScrapeCandidate>
>('actresses.applyScrapeCandidate', applyActressScrapeCandidate)

export const replacePendingVideoScrapeCommand = scrapeCommand<
  ScrapeInput<Parameters<typeof replacePendingVideoScrapeFromUploads>[0]>,
  ReturnType<typeof replacePendingVideoScrapeFromUploads>
>('pendingVideoScrapes.replace', replacePendingVideoScrapeFromUploads)

export const submitActressScrapeConflictCommand = scrapeCommand<
  ScrapeInput<Parameters<typeof submitActressScrapeConflict>[0]>,
  ReturnType<typeof submitActressScrapeConflict>
>('actressConflicts.submit', submitActressScrapeConflict)

export function confirmPendingVideoScrapeCommand(input: PendingVideoScrapeConfirmInput, context: CatalogWriteContext) {
  return commitManageImageMutation({ ...context, operation: 'pendingVideoScrapes.confirm', input }, () => {
    const revision = context.expectedVersions.Q?.revision
    if (revision == null) throw structuredError('INVALID_INPUT', '待确认操作需要 Q 版本', { field: 'expectedVersions.Q' }, context.operationId)
    // Read inside the receipt transaction: a retry may refer to an already removed row.
    const snapshot = getPendingVideoScrapeResolutionSnapshot(input.pendingScrapeId)
    if (!snapshot) throw structuredError('INVALID_INPUT', '待确认影片刮削结果不存在')
    assertExpectedVideoVersion(snapshot.pending.videoId, context.expectedVersions, context.operationId, context.database)
    const result = confirmPendingVideoScrape(input, { expectedRevision: revision })
    const videoId = input.mergeRetainedVideoId ?? snapshot.pending.videoId
    if (result.applied) bumpRowRevision('videos', videoId, context.database)
    return { ...result, versions: { V: readVideoAggregateVersion(videoId, context.database) } }
  }, context.database)
}
