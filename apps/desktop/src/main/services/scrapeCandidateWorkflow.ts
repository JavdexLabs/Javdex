import type { VideoScrapeField } from '@shared/videoScrapeTypes'
import type { ActressScrapeDisposition, ActressScrapeField } from '@shared/actressScrapeTypes'
import type { collectVideoScrape, ScrapeOutcome } from '../scrapers/scraperManager'
import type { collectActressScrape, CollectedActressScrape } from '../scrapers/actressScraperManager'

type VideoCollection = Awaited<ReturnType<typeof collectVideoScrape>>

/** A source's complete candidate set is retained for review, including unselected assets. */
export function videoCandidateSources(run: VideoCollection, effective: VideoScrapeField[]) {
  return run.source
    ? [{
      pluginName: run.resolvedScraperName,
      pluginSource: run.descriptor?.source ?? ('builtin' as const),
      pluginVersion: run.descriptor?.version ?? null,
      supportedFields: run.descriptor?.supportedFields ?? run.requested,
      sourceName: run.sourceName,
      selectedFields: effective,
      candidates: run.collected.candidates
    }]
    : (run.compositeOutcome?.sources ?? []).map((item) => ({
      pluginName: item.pluginName,
      pluginSource: item.descriptor?.source ?? ('builtin' as const),
      pluginVersion: item.descriptor?.version ?? null,
      supportedFields: [...item.supportedFields],
      sourceName: item.pluginName,
      selectedFields: item.selectedFields,
      candidates: item.candidates
    }))
}

export interface VideoCandidatePlan {
  run: VideoCollection
  candidate: VideoCollection['collected']['candidates'][number]
  fieldsToApply: VideoScrapeField[]
  sources: ReturnType<typeof videoCandidateSources>
  ambiguous: boolean
}

/** Collect, interpret candidates, and dispatch to the host's persistence boundary. */
export async function runVideoCandidateWorkflow<Context>(
  input: Parameters<typeof collectVideoScrape>[0] & {
    // Local apply historically receives the original supported request; remote
    // apply receives the effective supported request. Keep that distinction.
    singleSourceFieldsToApply?: VideoScrapeField[]
  },
  ports: {
    collect: typeof collectVideoScrape
    markFailed(): void | Promise<void>
    prepare(plan: VideoCandidatePlan): Context | Promise<Context>
    reviewWarnings(plan: VideoCandidatePlan, context: Context): string[] | null
    pending(plan: VideoCandidatePlan, context: Context, warnings: string[]): Promise<ScrapeOutcome>
    apply(plan: VideoCandidatePlan, context: Context): Promise<ScrapeOutcome>
  }
): Promise<ScrapeOutcome> {
  const run = await ports.collect(input)
  const candidate = run.collected.candidates[0]
  if (!candidate?.result) {
    if (run.source?.descriptor.kind === 'local-nfo' || run.compositeOutcome?.quietNoMatch) {
      return { ok: true, skipped: true, warnings: run.collected.warnings }
    }
    await ports.markFailed()
    return { ok: false, error: '未找到匹配的元数据', warnings: run.collected.warnings }
  }
  const sources = videoCandidateSources(run, input.fields)
  const plan: VideoCandidatePlan = {
    run,
    candidate,
    fieldsToApply: run.compositeOutcome?.matchedFields ?? input.singleSourceFieldsToApply ?? run.requested,
    sources,
    ambiguous: sources.some((source) => source.candidates.length > 1)
  }
  const context = await ports.prepare(plan)
  const reviewWarnings = ports.reviewWarnings(plan, context)
  if (plan.ambiguous || reviewWarnings !== null) {
    return ports.pending(plan, context, [...run.collected.warnings, ...(reviewWarnings ?? [])])
  }
  return ports.apply(plan, context)
}

export type PreparedActressCandidate = CollectedActressScrape & {
  result: NonNullable<CollectedActressScrape['result']>
  applicableFields: ActressScrapeField[]
}

/** Profile collection and selected-field projection are identical for both hosts. */
export async function runActressCandidateWorkflow(
  input: Parameters<typeof collectActressScrape>[0],
  ports: {
    collect: typeof collectActressScrape
    markFailed(): void | Promise<void>
    persist(candidate: PreparedActressCandidate): ActressScrapeDisposition | Promise<ActressScrapeDisposition>
    onError(error: unknown): ActressScrapeDisposition | Promise<ActressScrapeDisposition>
    close(): void
  }
): Promise<ActressScrapeDisposition> {
  try {
    const collected = await ports.collect(input)
    if (!collected.result) {
      await ports.markFailed()
      return {
        status: 'failure', ok: false, error: '未找到匹配的演员资料',
        warnings: collected.sourceWarnings.length ? collected.sourceWarnings : undefined
      }
    }
    const persistence = ports.persist({
      ...collected,
      result: collected.result,
      applicableFields: collected.fieldsToApply.filter((field) => input.fields.includes(field))
    })
    return persistence instanceof Promise ? await persistence : persistence
  } catch (error) {
    return await ports.onError(error)
  } finally {
    ports.close()
  }
}
