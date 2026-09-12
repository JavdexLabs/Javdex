import type { ScanCompletionResult, ScanExecutionResult } from './libraryTypes'

export function getUnrecognizedFileCount(result: ScanExecutionResult): number {
  return 'unrecognizedCount' in result ? result.unrecognizedCount : result.unrecognizedFiles.length
}

/** Allowlist the IPC payload, including when a structurally typed input carries extra fields. */
export function toScanCompletionResult(result: ScanExecutionResult): ScanCompletionResult {
  return {
    libraryId: result.libraryId, runId: result.runId,
    scannedFiles: result.scannedFiles, imported: result.imported,
    skipped: result.skipped, skippedShort: result.skippedShort, failed: result.failed,
    pendingGroups: result.pendingGroups, pendingResources: result.pendingResources,
    relocated: result.relocated, refreshed: result.refreshed, removed: result.removed,
    promoted: result.promoted, deletedVideos: result.deletedVideos,
    offlineFolders: result.offlineFolders, strmFailures: result.strmFailures,
    omittedStrmFailures: result.omittedStrmFailures,
    unrecognizedCount: getUnrecognizedFileCount(result),
    ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled })
  }
}
