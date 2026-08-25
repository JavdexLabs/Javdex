import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, SettingsSnapshot } from '@shared/settingsTypes'
import type { LibraryPathRemovalPreview, LibraryScanAudit, ScanResult } from '@shared/libraryTypes'
import { buildLibraryScanNotification } from '@shared/libraryScanNotification'
import { api } from '../api'
import { useToast } from '../components/Toast'
import { useQueryClient } from '@tanstack/react-query'
import { invalidateAllLibraryQueries } from '../query/invalidateLibraryQueries'
import {
  dismissMaintenanceHint,
  MAINTENANCE_HINT_KEYS
} from '../utils/maintenanceHints'

interface Options {
  settings: SettingsSnapshot | null
  setSettings: Dispatch<SetStateAction<SettingsSnapshot | null>>
}

export default function useLibrarySettingsController({ settings, setSettings }: Options) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const pathPreviewRequestRef = useRef(0)
  const [pathRemoval, setPathRemoval] = useState<{
    path: string
    preview: LibraryPathRemovalPreview | null
  } | null>(null)
  const [pathRemoveBusy, setPathRemoveBusy] = useState<'preview' | 'confirm' | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [unrecognized, setUnrecognized] = useState<string[]>([])
  const [scanAudit, setScanAudit] = useState<LibraryScanAudit | null>(null)
  const [pendingScanGroupIds, setPendingScanGroupIds] = useState<Set<number>>(new Set())
  const [overviewStatsRefreshKey, setOverviewStatsRefreshKey] = useState(0)
  const [scanScrapePrompt, setScanScrapePrompt] = useState<{
    imported: number
    unscraped: number
  } | null>(null)
  const persistedUnrecognized = settings?.unrecognizedFiles

  useEffect(() => {
    setUnrecognized(persistedUnrecognized ?? [])
  }, [persistedUnrecognized])

  const refreshScanAudit = useCallback(async (): Promise<void> => {
    const [audit, pendingGroups] = await Promise.all([
      api.scan.getAudit(),
      api.scan.listPending()
    ])
    setScanAudit(audit)
    setPendingScanGroupIds(new Set(pendingGroups.map((group) => group.id)))
  }, [])

  useEffect(() => {
    void refreshScanAudit().catch(() => undefined)
  }, [refreshScanAudit])

  useEffect(
    () =>
      api.scan.onProgress((progress) => {
        setScanning(true)
        setScanStatus(`已扫描 ${progress.scanned} 个文件，新导入 ${progress.imported} 部`)
      }),
    []
  )

  useEffect(
    () =>
      api.scan.onStateChanged((event) => {
        if (event.trigger === 'manual') return
        if (event.phase === 'started') {
          setScanning(true)
          setScanResult(null)
          setScanStatus('自动扫描中…')
          return
        }
        if (event.phase === 'progress') return

        setScanning(false)
        setScanStatus(event.phase === 'failed' ? `自动扫描失败：${event.error}` : '')
        if (event.phase === 'completed') {
          setScanResult(event.result)
          const strmFailures = event.result.strmFailures.length + event.result.omittedStrmFailures
          const processingFailures = Math.max(
            0,
            event.result.failed - event.result.unrecognizedFiles.length - strmFailures
          )
          if (!event.result.cancelled && processingFailures === 0) {
            setUnrecognized(event.result.unrecognizedFiles)
          }
        }
        void api.settings.get().then(setSettings).catch(() => undefined)
        void refreshScanAudit().catch(() => undefined)
        setOverviewStatsRefreshKey((key) => key + 1)
      }),
    [refreshScanAudit, setSettings]
  )

  const addFolders = async (): Promise<void> => {
    if (!settings) return
    try {
      const picked = await api.settings.pickFolder()
      if (!picked.length) return
      const merged = Array.from(new Set([...settings.libraryPaths, ...picked]))
      setSettings(await api.settings.update({ libraryPaths: merged }))
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    }
  }

  const requestRemovePath = async (libraryPath: string): Promise<void> => {
    const requestId = ++pathPreviewRequestRef.current
    setPathRemoval({ path: libraryPath, preview: null })
    setPathRemoveBusy('preview')
    try {
      const preview = await api.settings.previewLibraryPathRemoval(libraryPath)
      if (requestId !== pathPreviewRequestRef.current) return
      setPathRemoval((current) =>
        current?.path === libraryPath ? { path: libraryPath, preview } : current
      )
    } catch (error) {
      if (requestId !== pathPreviewRequestRef.current) return
      setPathRemoval(null)
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      if (requestId === pathPreviewRequestRef.current) setPathRemoveBusy(null)
    }
  }

  const closePathRemoval = useCallback((): void => {
    pathPreviewRequestRef.current += 1
    setPathRemoval(null)
    setPathRemoveBusy(null)
  }, [])

  const confirmRemovePath = async (): Promise<void> => {
    if (!pathRemoval?.preview || pathRemoveBusy) return
    setPathRemoveBusy('confirm')
    try {
      setSettings(await api.settings.confirmLibraryPathRemoval(pathRemoval.path))
      closePathRemoval()
      toast.show('已移除路径，资源记录将在下次成功扫描后清理', 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
      setPathRemoveBusy(null)
    }
  }

  const patchLibrarySettings = async (
    patch: Partial<Pick<
      AppSettings,
      | 'minScanImportDurationMinutes'
      | 'autoDeleteResourceLessVideos'
      | 'autoScanEnabled'
      | 'autoScanIntervalMinutes'
    >>
  ): Promise<void> => {
    try {
      setSettings(await api.settings.update(patch))
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    }
  }

  const refreshSettingsSnapshot = async (): Promise<void> => {
    try {
      setSettings(await api.settings.get())
    } catch (error) {
      toast.show(`扫描结果已保留，但刷新设置摘要失败：${String((error as Error).message ?? error)}`, 'error')
    }
  }

  const runScan = async (): Promise<void> => {
    if (!settings) return
    if (!settings.libraryPaths.length && !settings.pendingLibraryPathCleanups.length) {
      toast.show('请先添加媒体库路径', 'error')
      return
    }
    if (scanning) return
    setScanning(true)
    setScanResult(null)
    setScanStatus('扫描中…')
    try {
      const result = await api.scan.run()
      setScanResult(result)
      const strmFailures = result.strmFailures.length + result.omittedStrmFailures
      const processingFailures = Math.max(
        0,
        result.failed - result.unrecognizedFiles.length - strmFailures
      )
      if (!result.cancelled && processingFailures === 0) {
        setUnrecognized(result.unrecognizedFiles)
      }
      setScanStatus('')
      const notification = buildLibraryScanNotification(result)
      if (notification) {
        toast.show(
          notification.message,
          notification.tone === 'warning' ? 'info' : notification.tone
        )
      }
      await refreshSettingsSnapshot()
      await refreshScanAudit()
      invalidateAllLibraryQueries(queryClient)
      setOverviewStatsRefreshKey((key) => key + 1)
      if (!result.cancelled && result.imported > 0) {
        try {
          const stats = await api.settings.getOverviewStats()
          if (
            stats.videos.unscraped > 0 &&
            !sessionStorage.getItem(MAINTENANCE_HINT_KEYS.scanScrapePrompt)
          ) {
            setScanScrapePrompt({
              imported: result.imported,
              unscraped: stats.videos.unscraped
            })
          } else {
            setScanScrapePrompt(null)
          }
        } catch (error) {
          toast.show(`扫描完成，但读取媒体库统计失败：${String((error as Error).message ?? error)}`, 'error')
        }
      } else {
        setScanScrapePrompt(null)
      }
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
      setScanStatus('')
      await refreshSettingsSnapshot()
    } finally {
      setScanning(false)
    }
  }

  const cancelScan = async (): Promise<void> => {
    try {
      if (await api.scan.cancel()) setScanStatus('正在取消扫描…')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    }
  }

  const handleResolved = (oldPath: string): void => {
    setUnrecognized((current) => current.filter((item) => item !== oldPath))
  }

  const dismissScanScrapePrompt = (): void => {
    dismissMaintenanceHint(MAINTENANCE_HINT_KEYS.scanScrapePrompt)
    setScanScrapePrompt(null)
  }

  return {
    pathRemoval,
    pathRemoveBusy,
    closePathRemoval,
    requestRemovePath,
    confirmRemovePath,
    scanning,
    scanStatus,
    scanResult,
    scanAudit,
    pendingScanGroupIds,
    unrecognized,
    overviewStatsRefreshKey,
    scanScrapePrompt,
    addFolders,
    patchLibrarySettings,
    runScan,
    cancelScan,
    handleResolved,
    dismissScanScrapePrompt
  }
}
