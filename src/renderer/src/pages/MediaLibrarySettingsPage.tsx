import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { LibraryScanMetricKey } from '@shared/libraryTypes'
import {
  type MediaLibraryConfigValues,
  type MediaLibraryDeletePreview,
  type MediaLibraryRoot,
  type MediaLibrarySummary
} from '@shared/mediaLibraryTypes'
import { api } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import { NavIcon } from '../components/NavIcons'
import SelectControl from '../components/SelectControl'
import { useToast } from '../components/Toast'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { useMediaLibraryScanController } from '../hooks/useMediaLibraryScanController'
import { mediaLibraryIdentityStyle } from '../components/mediaLibraryIdentity'
import { SettingsTabBar } from '../components/settings/SettingsPrimitives'
import { ROUTE_PATH } from '../listView/routePaths'
import {
  MEDIA_LIBRARY_SETTINGS_TABS,
  MEDIA_LIBRARY_SETTINGS_TAB_LABELS,
  mediaLibrarySettingsPath,
  type MediaLibrarySettingsTab
} from '../listView/mediaLibraryRoutes'
import { parsePositiveRouteId } from '../listView/routeIds'
import {
  settingsPath,
  settingsTabDomId,
  settingsTabPanelDomId
} from '../settings/settingsRoutes'
import {
  buildMediaLibraryConfigPatch,
  buildMediaLibraryIdentityPatch,
  configDraftFromLibrary,
  identityDraftFromLibrary,
  mediaLibraryLifecycleCapabilities,
  mediaLibraryRootAddFailureMessage,
  mediaLibrarySettingsLoadState,
  rootRemovalRequiresCleanup,
  type MediaLibraryConfigKey,
  type MediaLibraryIdentityDraft
} from '../mediaLibrarySettingsState'
import styles from './MediaLibrarySettingsPage.module.css'
import {
  DisplaySettingsTab,
  MaintenanceSettingsTab,
  OverviewSettingsTab,
  ScrapingSettingsTab,
  SourcesAndScanSettingsTab
} from './MediaLibrarySettingsTabs'
import {
  MediaLibrarySettingsDialogs,
  type MediaLibrarySettingsBusyAction,
  type RootMigrationState,
  type RootRemovalState
} from './MediaLibrarySettingsDialogs'

function isSettingsTab(
  value: string | undefined
): value is MediaLibrarySettingsTab {
  return MEDIA_LIBRARY_SETTINGS_TABS.includes(value as MediaLibrarySettingsTab)
}

function messageFromError(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

export function MediaLibrarySettingsContent({
  libraryId,
  tab,
  libraries,
  onSelectLibrary,
  onSelectTab,
  onTabKeyDown
}: {
  libraryId: number
  tab: MediaLibrarySettingsTab
  libraries: readonly MediaLibrarySummary[]
  onSelectLibrary: (libraryId: number) => void
  onSelectTab: (tab: MediaLibrarySettingsTab) => void
  onTabKeyDown: KeyboardEventHandler<HTMLDivElement>
}): JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { scrapers, defaultScraper } = useScraperPluginCatalog('video')
  const queryKey = useMemo(
    () => ['media-libraries', 'detail', libraryId] as const,
    [libraryId]
  )
  const libraryQuery = useQuery({
    queryKey,
    queryFn: () => api.mediaLibraries.get(libraryId)
  })
  const activeLibrariesQuery = useQuery({
    queryKey: ['media-libraries', 'list', 'active'],
    queryFn: () => api.mediaLibraries.list()
  })
  const pendingGroupsQuery = useQuery({
    queryKey: ['pending-scan-groups', libraryId],
    queryFn: () => api.scan.listPending(libraryId)
  })
  const pendingScanGroupIds = useMemo(
    () => new Set((pendingGroupsQuery.data ?? []).map((group) => group.id)),
    [pendingGroupsQuery.data]
  )
  const scan = useMediaLibraryScanController(libraryId, {
    onSettled: () => libraryQuery.refetch().then(() => undefined)
  })
  const library = libraryQuery.data ?? null
  const [identityDraft, setIdentityDraft] =
    useState<MediaLibraryIdentityDraft | null>(null)
  const [configDraft, setConfigDraft] =
    useState<MediaLibraryConfigValues | null>(null)
  const immediateConfigMutationPendingRef = useRef(false)
  const [busy, setBusy] = useState<MediaLibrarySettingsBusyAction>(null)
  const [rootRemoval, setRootRemoval] = useState<RootRemovalState | null>(null)
  const [rootMigration, setRootMigration] = useState<RootMigrationState | null>(
    null
  )
  const [lifecycleConfirm, setLifecycleConfirm] = useState<'archive' | null>(
    null
  )
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deletePreview, setDeletePreview] =
    useState<MediaLibraryDeletePreview | null>(null)
  const [selectedScanMetric, setSelectedScanMetric] =
    useState<LibraryScanMetricKey | null>(null)

  useEffect(() => {
    setSelectedScanMetric(null)
  }, [libraryId])

  useEffect(() => {
    if (!library) return
    setIdentityDraft(identityDraftFromLibrary(library))
    setConfigDraft(configDraftFromLibrary(library.config))
  }, [library])

  const refreshSurfaces = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['media-libraries'] }),
      queryClient.invalidateQueries({ queryKey: ['home'] }),
      queryClient.invalidateQueries({ queryKey: ['videos'] })
    ])
    await libraryQuery.refetch()
  }

  const runMutation = async (
    action: Exclude<MediaLibrarySettingsBusyAction, null>,
    successMessage: string,
    operation: () => Promise<unknown>
  ): Promise<boolean> => {
    if (busy) return false
    setBusy(action)
    try {
      await operation()
      await refreshSurfaces()
      toast.show(successMessage, 'success')
      return true
    } catch (error) {
      toast.show(messageFromError(error), 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  const updateConfigDraft = <Key extends keyof MediaLibraryConfigValues>(
    key: Key,
    value: MediaLibraryConfigValues[Key]
  ): void => {
    setConfigDraft((current) =>
      current ? { ...current, [key]: value } : current
    )
  }

  const saveIdentity = async (): Promise<void> => {
    if (!library || !identityDraft) return
    try {
      const patch = buildMediaLibraryIdentityPatch(library, identityDraft)
      if (!patch) {
        toast.show('常规设置没有变化', 'info')
        return
      }
      await runMutation('identity', '媒体库常规设置已保存', () =>
        api.mediaLibraries.update({
          libraryId,
          expectedRevision: library.revision,
          patch
        })
      )
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    }
  }

  const saveConfig = async (
    keys: readonly MediaLibraryConfigKey[],
    successMessage: string
  ): Promise<void> => {
    if (!library || !configDraft) return
    try {
      const patch = buildMediaLibraryConfigPatch(
        library.config,
        configDraft,
        keys
      )
      if (!patch) {
        toast.show('当前设置没有变化', 'info')
        return
      }
      await runMutation('config', successMessage, () =>
        api.mediaLibraries.updateConfig({
          libraryId,
          expectedRevision: library.config.revision,
          patch
        })
      )
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    }
  }

  const addRoots = async (): Promise<void> => {
    if (!library || busy) return
    setBusy('add-root')
    let added = 0
    try {
      const picked = [...new Set(await api.settings.pickFolder())]
      if (picked.length === 0) return
      const initial = await api.mediaLibraries.get(libraryId)
      if (!initial) throw new Error('媒体库不存在')
      let expectedRevision = initial.revision
      for (const path of picked) {
        await api.mediaLibraries.addRoot({
          libraryId,
          expectedRevision,
          root: { path, state: 'active' }
        })
        added += 1
        const current = await api.mediaLibraries.get(libraryId)
        if (!current) throw new Error('媒体库状态刷新失败')
        expectedRevision = current.revision
      }
      await refreshSurfaces()
      toast.show(`已添加 ${added} 个来源目录`, 'success')
    } catch (error) {
      if (added > 0) {
        try {
          await refreshSurfaces()
        } catch {
          // The mutation result is still explicit even if the follow-up refresh also fails.
        }
        toast.show(
          mediaLibraryRootAddFailureMessage(added, messageFromError(error)),
          'error'
        )
      } else {
        toast.show(messageFromError(error), 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  const toggleRoot = async (root: MediaLibraryRoot): Promise<void> => {
    if (!library || (root.state !== 'active' && root.state !== 'disabled'))
      return
    await runMutation(
      'root-state',
      root.state === 'active' ? '来源目录已停用' : '来源目录已启用',
      () =>
        api.mediaLibraries.updateRoot({
          libraryId,
          rootId: root.id,
          expectedRevision: library.revision,
          patch: { state: root.state === 'active' ? 'disabled' : 'active' }
        })
    )
  }

  const requestRootRemoval = async (root: MediaLibraryRoot): Promise<void> => {
    if (!library || busy) return
    if (root.state === 'pending_removal' || root.state === 'archived') return
    setBusy('remove-root')
    try {
      const preview = await api.settings.previewLibraryPathRemoval(
        libraryId,
        root.id
      )
      setRootRemoval({
        kind: rootRemovalRequiresCleanup(preview) ? 'cleanup' : 'direct',
        root,
        preview
      })
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const confirmRootRemoval = async (): Promise<void> => {
    if (!library || !rootRemoval) return
    const target = rootRemoval
    const succeeded = await runMutation(
      'remove-root',
      '来源目录移除任务已更新',
      () =>
        target.kind === 'cleanup'
          ? api.settings.confirmLibraryPathRemoval(
              libraryId,
              target.root.id,
              target.preview.libraryRevision,
              target.preview.impactRevision
            )
          : api.mediaLibraries.removeRoot({
              libraryId,
              rootId: target.root.id,
              expectedRevision: target.preview.libraryRevision,
              expectedImpactRevision: target.preview.impactRevision
            })
    )
    if (succeeded) setRootRemoval(null)
  }

  const cancelRootRemoval = async (root: MediaLibraryRoot): Promise<void> => {
    if (!library || root.state !== 'pending_removal') return
    await runMutation(
      'cancel-root-removal',
      '已取消移除，来源目录保持停用',
      () =>
        api.mediaLibraries.cancelRootRemoval({
          libraryId,
          rootId: root.id,
          expectedRevision: library.revision
        })
    )
  }

  const migrationTargetsFrom = (
    candidates: readonly MediaLibrarySummary[] | undefined
  ): MediaLibrarySummary[] =>
    (candidates ?? []).filter(
      (candidate) => candidate.id !== libraryId && candidate.status === 'active'
    )

  const requestRootMigration = async (
    root: MediaLibraryRoot
  ): Promise<void> => {
    if (busy || (root.state !== 'active' && root.state !== 'disabled')) return
    try {
      const candidates =
        activeLibrariesQuery.data ?? (await activeLibrariesQuery.refetch()).data
      const targets = migrationTargetsFrom(candidates)
      if (targets.length === 0) {
        toast.show('没有可接收该目录的其它活动媒体库', 'info')
        return
      }
      setRootMigration({ root, targetLibraryId: targets[0].id, preview: null })
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    }
  }

  const loadRootMigrationPreview = async (): Promise<void> => {
    if (!rootMigration || busy) return
    const requested = rootMigration
    setBusy('migrate-root-preview')
    try {
      const preview = await api.mediaLibraries.previewRootMigration({
        sourceLibraryId: libraryId,
        targetLibraryId: requested.targetLibraryId,
        rootId: requested.root.id
      })
      setRootMigration((current) =>
        current?.root.id === requested.root.id &&
        current.targetLibraryId === requested.targetLibraryId
          ? { ...current, preview }
          : current
      )
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const confirmRootMigration = async (): Promise<void> => {
    if (!rootMigration?.preview) {
      await loadRootMigrationPreview()
      return
    }
    const requested = rootMigration
    const succeeded = await runMutation(
      'migrate-root',
      '来源目录已迁移',
      async () => {
        const result = await api.mediaLibraries.migrateRoot({
          sourceLibraryId: libraryId,
          targetLibraryId: requested.targetLibraryId,
          rootId: requested.root.id,
          expectedSourceRevision: requested.preview!.sourceRevision,
          expectedTargetRevision: requested.preview!.targetRevision,
          expectedImpactRevision: requested.preview!.impactRevision
        })
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['pending-scan-groups'] }),
          queryClient.invalidateQueries({
            queryKey: ['media-library-scan-latest', libraryId],
            exact: true
          }),
          queryClient.invalidateQueries({
            queryKey: ['media-library-scan-latest', requested.targetLibraryId],
            exact: true
          })
        ])
        return result
      }
    )
    if (succeeded) setRootMigration(null)
  }

  const archiveLibrary = async (): Promise<void> => {
    if (!library) return
    const succeeded = await runMutation('archive', '媒体库已归档', () =>
      api.mediaLibraries.archive({
        libraryId,
        expectedRevision: library.revision
      })
    )
    if (succeeded) setLifecycleConfirm(null)
  }

  const restoreLibrary = async (): Promise<void> => {
    if (!library) return
    await runMutation('restore', '媒体库已恢复', () =>
      api.mediaLibraries.restore({
        libraryId,
        expectedRevision: library.revision
      })
    )
  }

  const openDeleteConfirmation = async (): Promise<void> => {
    if (
      !library ||
      !mediaLibraryLifecycleCapabilities(library).canDelete ||
      busy
    )
      return
    setBusy('delete-preview')
    try {
      const preview = await api.mediaLibraries.previewRemoval(libraryId)
      setDeletePreview(preview)
      setDeleteConfirmation('')
      setDeleteConfirmOpen(true)
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const deleteLibrary = async (): Promise<void> => {
    if (
      !library ||
      !deletePreview ||
      library.status !== 'archived' ||
      deleteConfirmation.trim() !== deletePreview.name
    ) {
      return
    }
    if (busy) return
    setBusy('delete')
    try {
      await api.mediaLibraries.remove({
        libraryId,
        expectedRevision: deletePreview.revision,
        expectedImpactRevision: deletePreview.impactRevision
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['media-libraries'] }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['videos'] })
      ])
      toast.show('媒体库已永久删除', 'success')
      navigate(settingsPath('library'), { replace: true })
    } catch (error) {
      toast.show(messageFromError(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const loadState = mediaLibrarySettingsLoadState({
    isLoading: libraryQuery.isLoading,
    isError: libraryQuery.isError,
    hasLibrary: library != null,
    hasDrafts: identityDraft != null && configDraft != null
  })

  if (loadState === 'error') {
    return (
      <EmptyState
        title="无法打开媒体库设置"
        description="媒体库不存在，或设置暂时无法读取。"
      >
        <Button size="sm" onClick={() => void libraryQuery.refetch()}>
          重新加载
        </Button>
      </EmptyState>
    )
  }

  const updateConfigImmediately = async <
    Key extends keyof MediaLibraryConfigValues
  >(
    key: Key,
    value: MediaLibraryConfigValues[Key]
  ): Promise<void> => {
    if (
      !library ||
      !configDraft ||
      busy ||
      immediateConfigMutationPendingRef.current ||
      Object.is(configDraft[key], value)
    ) {
      return
    }

    const previousValue = configDraft[key]
    const nextDraft: MediaLibraryConfigValues = {
      ...configDraft,
      [key]: value
    }
    const patch = buildMediaLibraryConfigPatch(
      library.config,
      nextDraft,
      [key]
    )
    if (!patch) return

    setConfigDraft(nextDraft)
    immediateConfigMutationPendingRef.current = true
    setBusy('config')
    try {
      await api.mediaLibraries.updateConfig({
        libraryId,
        expectedRevision: library.config.revision,
        patch
      })
      await refreshSurfaces()
    } catch (error) {
      setConfigDraft((current) =>
        current ? { ...current, [key]: previousValue } : current
      )
      toast.show(messageFromError(error), 'error')
    } finally {
      immediateConfigMutationPendingRef.current = false
      setBusy(null)
    }
  }

  if (loadState === 'loading' || !library || !identityDraft || !configDraft) {
    return <EmptyState loading title="正在读取媒体库设置…" />
  }

  const archived = library.status === 'archived'
  const formDisabled = archived || scan.running || busy !== null
  const configuredScrapers = library.config.defaultVideoScraper
    ? [library.config.defaultVideoScraper, ...scrapers]
    : scrapers
  const scraperOptions = [...new Set(configuredScrapers)]
  const migrationTargets = migrationTargetsFrom(activeLibrariesQuery.data)
  const latestScanSummary = scan.latest?.summary ?? null

  return (
    <>
      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <div
              className={styles.identity}
              style={mediaLibraryIdentityStyle(library.color)}
            >
              <span className={styles.identityIcon} aria-hidden>
                <NavIcon name={library.icon} />
              </span>
              <h1 className={styles.pageTitle}>{library.name}</h1>
            </div>
            <div className={styles.headerControls}>
              {libraries.length > 1 ? (
                <div className={styles.libraryPicker}>
                  <SelectControl
                    className={styles.librarySelect}
                    value={libraryId}
                    aria-label="选择要配置的媒体库"
                    onChange={(event) =>
                      onSelectLibrary(Number(event.target.value))
                    }
                  >
                    {libraries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.status === 'archived' ? '（已归档）' : ''}
                      </option>
                    ))}
                  </SelectControl>
                </div>
              ) : null}
              <span className={styles.status} data-status={library.status}>
                {archived ? '已归档' : '活动中'}
              </span>
              {scan.running ? (
                <span className={styles.activityStatus} role="status">
                  正在扫描
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <SettingsTabBar
          group="library"
          tabs={MEDIA_LIBRARY_SETTINGS_TABS.map((id) => ({
            id,
            label: MEDIA_LIBRARY_SETTINGS_TAB_LABELS[id]
          }))}
          activeTab={tab}
          label="媒体库设置页签"
          onSelect={(nextTab) => {
            if (isSettingsTab(nextTab)) onSelectTab(nextTab)
          }}
          onKeyDown={onTabKeyDown}
        />

        <section
          className={`${styles.panel}${tab === 'sources' ? ` ${styles.importPanel}` : ''}`}
          role="tabpanel"
          id={settingsTabPanelDomId('library', tab)}
          aria-labelledby={settingsTabDomId('library', tab)}
        >
          {tab === 'general' ? (
            <OverviewSettingsTab
              identityDraft={identityDraft}
              setIdentityDraft={setIdentityDraft}
              formDisabled={formDisabled}
              saveIdentity={saveIdentity}
            />
          ) : null}
          {tab === 'sources' ? (
            <SourcesAndScanSettingsTab
              libraryId={libraryId}
              library={library}
              scan={scan}
              latestScanSummary={latestScanSummary}
              pendingScanGroupIds={pendingScanGroupIds}
              selectedScanMetric={selectedScanMetric}
              setSelectedScanMetric={setSelectedScanMetric}
              configDraft={configDraft}
              updateConfigImmediately={updateConfigImmediately}
              formDisabled={formDisabled}
              navigate={navigate}
              addRoots={addRoots}
              requestRootMigration={requestRootMigration}
              toggleRoot={toggleRoot}
              requestRootRemoval={requestRootRemoval}
              cancelRootRemoval={cancelRootRemoval}
            />
          ) : null}
          {tab === 'scraping' ? (
            <ScrapingSettingsTab
              configDraft={configDraft}
              updateConfigDraft={updateConfigDraft}
              formDisabled={formDisabled}
              defaultScraper={defaultScraper}
              scraperOptions={scraperOptions}
              saveConfig={saveConfig}
            />
          ) : null}
          {tab === 'display' ? (
            <DisplaySettingsTab
              configDraft={configDraft}
              updateConfigDraft={updateConfigDraft}
              formDisabled={formDisabled}
              saveConfig={saveConfig}
            />
          ) : null}
          {tab === 'danger' ? (
            <MaintenanceSettingsTab
              library={library}
              archived={archived}
              busy={busy}
              requestArchive={() => setLifecycleConfirm('archive')}
              restoreLibrary={restoreLibrary}
              openDeleteConfirmation={openDeleteConfirmation}
            />
          ) : null}
        </section>
      </div>

      <MediaLibrarySettingsDialogs
        rootRemoval={rootRemoval}
        setRootRemoval={setRootRemoval}
        rootMigration={rootMigration}
        setRootMigration={setRootMigration}
        migrationTargets={migrationTargets}
        lifecycleConfirm={lifecycleConfirm}
        setLifecycleConfirm={setLifecycleConfirm}
        deleteConfirmOpen={deleteConfirmOpen}
        setDeleteConfirmOpen={setDeleteConfirmOpen}
        deletePreview={deletePreview}
        setDeletePreview={setDeletePreview}
        deleteConfirmation={deleteConfirmation}
        setDeleteConfirmation={setDeleteConfirmation}
        library={library}
        busy={busy}
        confirmRootRemoval={confirmRootRemoval}
        confirmRootMigration={confirmRootMigration}
        archiveLibrary={archiveLibrary}
        deleteLibrary={deleteLibrary}
      />
    </>
  )
}

export default function MediaLibrarySettingsPage(): JSX.Element {
  const params = useParams()
  const libraryId = parsePositiveRouteId(params.libraryId)
  const tab = params.tab
  if (libraryId == null) return <Navigate to={ROUTE_PATH.home} replace />
  if (!isSettingsTab(tab)) {
    return (
      <Navigate to={mediaLibrarySettingsPath(libraryId, 'sources')} replace />
    )
  }
  return <Navigate to={mediaLibrarySettingsPath(libraryId, tab)} replace />
}
