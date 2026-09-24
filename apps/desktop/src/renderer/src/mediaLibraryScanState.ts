import type { LibraryScanProgressEvent } from '@shared/libraryTypes'

/** Strict event gate shared by scan subscriptions and contract tests. */
export function matchesMediaLibraryScanRun(
  libraryId: number,
  activeRunId: string | null,
  event: Pick<LibraryScanProgressEvent, 'libraryId' | 'runId'>
): boolean {
  return (
    event.libraryId === libraryId &&
    (activeRunId == null || event.runId === activeRunId)
  )
}
