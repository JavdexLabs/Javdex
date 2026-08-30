import type { ScanResult } from './libraryTypes'

export interface LibraryScanNotification {
  message: string
  tone: 'success' | 'warning' | 'info'
}

export function buildLibraryScanNotification(
  result: ScanResult
): LibraryScanNotification | null {
  if (result.cancelled) {
    return {
      message: `扫描已取消：已扫描 ${result.scannedFiles} 个文件，新增 ${result.imported} 条资源`,
      tone: 'info'
    }
  }
  const strmFailureCount = result.strmFailures.length + result.omittedStrmFailures
  const processingFailures = Math.max(
    0,
    result.failed - result.unrecognizedFiles.length - strmFailureCount
  )
  if (processingFailures > 0) {
    return {
      message: `扫描失败：${processingFailures} 个文件处理失败，已跳过资源清理`,
      tone: 'warning'
    }
  }
  if (result.offlineFolders.length > 0) {
    return {
      message: `扫描完成，但有 ${result.offlineFolders.length} 个媒体库目录离线，已跳过危险清理`,
      tone: 'warning'
    }
  }
  if (strmFailureCount > 0) {
    const unrecognizedSuffix =
      result.unrecognizedFiles.length > 0
        ? `，另有 ${result.unrecognizedFiles.length} 个文件无法识别`
        : ''
    return {
      message: `扫描完成但有失败项：${strmFailureCount} 个 STRM 文件处理失败${unrecognizedSuffix}，请查看最近一次扫描`,
      tone: 'warning'
    }
  }
  if (result.failed > 0) {
    return {
      message: `扫描完成：${result.failed} 个文件无法识别，请查看待处理列表`,
      tone: 'warning'
    }
  }
  if (result.pendingGroups > 0) {
    return {
      message: `扫描完成：${result.pendingGroups} 个待确认扫描组，共 ${result.pendingResources} 条资源`,
      tone: 'warning'
    }
  }

  const changed =
    result.imported +
    result.relocated +
    result.refreshed +
    result.removed +
    result.promoted +
    result.deletedVideos
  if (changed === 0) return null
  return {
    message: `扫描完成：新增 ${result.imported}，更新 ${result.relocated + result.refreshed}，移除 ${result.removed}，提升主资源 ${result.promoted}，移出无资源成员 ${result.deletedVideos}`,
    tone: 'success'
  }
}
