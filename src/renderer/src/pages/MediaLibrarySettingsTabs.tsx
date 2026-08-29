import type { Dispatch, SetStateAction, ChangeEvent } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { Archive, FolderPlus, RefreshCw, Save, Trash2 } from 'lucide-react'
import type {
  LibraryScanMetricKey,
  LibraryScanSummary
} from '@shared/libraryTypes'
import {
  MEDIA_LIBRARY_COLORS,
  MEDIA_LIBRARY_DEFAULT_SORTS,
  MEDIA_LIBRARY_ICONS,
  type MediaLibraryConfigValues,
  type MediaLibraryDetail,
  type MediaLibraryRoot
} from '@shared/mediaLibraryTypes'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import { AppFormField, AppFormSection } from '../components/FormPrimitives'
import { UI_ICON_SM } from '../components/iconDefaults'
import { NavIcon } from '../components/NavIcons'
import SelectControl from '../components/SelectControl'
import Switch from '../components/Switch'
import LibraryScanAuditPanel from '../components/settings/LibraryScanAuditPanel'
import UnrecognizedRow from '../components/settings/UnrecognizedRow'
import type { useMediaLibraryScanController } from '../hooks/useMediaLibraryScanController'
import {
  canRunMediaLibraryScan,
  mediaLibraryLifecycleCapabilities,
  type MediaLibraryConfigKey,
  type MediaLibraryIdentityDraft
} from '../mediaLibrarySettingsState'
import { mediaLibraryVideoDetailPath } from '../listView/mediaLibraryRoutes'
import { pendingCenterPath, pendingItemKey } from '../listView/pendingRoutes'
import styles from './MediaLibrarySettingsPage.module.css'

const ICON_LABELS: Record<(typeof MEDIA_LIBRARY_ICONS)[number], string> = {
  library: '媒体库',
  film: '影片',
  folder: '文件夹',
  'hard-drive': '硬盘',
  cloud: '云端',
  star: '收藏'
}

const COLOR_LABELS: Record<(typeof MEDIA_LIBRARY_COLORS)[number], string> = {
  slate: '中性',
  blue: '蓝色',
  violet: '紫色',
  rose: '玫红',
  amber: '琥珀',
  green: '绿色'
}

const ROOT_STATUS_LABELS: Record<MediaLibraryRoot['state'], string> = {
  active: '启用',
  pending_removal: '待移除',
  disabled: '已停用',
  archived: '已归档'
}

const SCAN_CONFIG_KEYS = [
  'autoScanEnabled',
  'autoScanIntervalMinutes',
  'minImportDurationMinutes',
  'autoMergeSameCodeResources',
  'removeResourceLessMemberships'
] as const satisfies readonly MediaLibraryConfigKey[]

const SCRAPING_CONFIG_KEYS = [
  'defaultVideoScraper'
] as const satisfies readonly MediaLibraryConfigKey[]

const DISPLAY_CONFIG_KEYS = [
  'defaultSortBy',
  'defaultSortDir',
  'includeInHomeDiscovery'
] as const satisfies readonly MediaLibraryConfigKey[]

type SaveConfig = (
  keys: readonly MediaLibraryConfigKey[],
  successMessage: string
) => Promise<void>

type UpdateConfigDraft = <Key extends keyof MediaLibraryConfigValues>(
  key: Key,
  value: MediaLibraryConfigValues[Key]
) => void

type ScanController = ReturnType<typeof useMediaLibraryScanController>

export interface MediaLibraryScanMetrics {
  scanned: number
  imported: number
  failed: number
  pending: number
  unrecognized: number
  offline: number
  offlineFolders: string[]
  errorSummary: string | null
  cancelled: boolean
  finishedAt: string | null
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className={styles.toggleRow}>
      <span className={styles.toggleCopy}>
        <strong className={styles.toggleTitle}>{title}</strong>
        <span className={styles.toggleDescription}>{description}</span>
      </span>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export function GeneralSettingsTab({
  identityDraft,
  setIdentityDraft,
  formDisabled,
  saveIdentity
}: {
  identityDraft: MediaLibraryIdentityDraft
  setIdentityDraft: Dispatch<SetStateAction<MediaLibraryIdentityDraft | null>>
  formDisabled: boolean
  saveIdentity: () => Promise<void>
}): JSX.Element {
  return (
    <form
      className={styles.sectionStack}
      onSubmit={(event) => {
        event.preventDefault()
        void saveIdentity()
      }}
    >
      <AppFormSection
        title="名称与识别"
        hint="名称显示在侧栏和媒体库页面；图标与颜色只用于区分媒体库。"
      >
        <AppFormField label="媒体库名称">
          <input
            className={styles.textControl}
            value={identityDraft.name}
            maxLength={200}
            disabled={formDisabled}
            onChange={(event) =>
              setIdentityDraft((current) =>
                current ? { ...current, name: event.target.value } : current
              )
            }
          />
        </AppFormField>

        <AppFormField
          label="导航排序"
          hint="数字越小越靠前；相同时按创建顺序排列。"
        >
          <input
            className={styles.textControl}
            type="number"
            min={0}
            step={1}
            value={identityDraft.position}
            disabled={formDisabled}
            onChange={(event) =>
              setIdentityDraft((current) =>
                current
                  ? { ...current, position: Number(event.target.value) }
                  : current
              )
            }
          />
        </AppFormField>

        <div className={styles.choiceGroup}>
          <span className={styles.fieldLabel}>图标</span>
          <div className={styles.iconChoices}>
            {MEDIA_LIBRARY_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                className={styles.iconChoice}
                aria-label={ICON_LABELS[icon]}
                aria-pressed={identityDraft.icon === icon}
                disabled={formDisabled}
                onClick={() =>
                  setIdentityDraft((current) =>
                    current ? { ...current, icon } : current
                  )
                }
              >
                <NavIcon name={icon} />
                <span>{ICON_LABELS[icon]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.choiceGroup}>
          <span className={styles.fieldLabel}>标识色</span>
          <div className={styles.colorChoices}>
            {MEDIA_LIBRARY_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={styles.colorChoice}
                data-color={color}
                aria-pressed={identityDraft.color === color}
                disabled={formDisabled}
                onClick={() =>
                  setIdentityDraft((current) =>
                    current ? { ...current, color } : current
                  )
                }
              >
                <span className={styles.colorDot} aria-hidden />
                {COLOR_LABELS[color]}
              </button>
            ))}
          </div>
        </div>
      </AppFormSection>
      <div className={styles.saveRow}>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={formDisabled}
        >
          <Save {...UI_ICON_SM} aria-hidden />
          保存常规设置
        </Button>
      </div>
    </form>
  )
}

export function SourcesSettingsTab({
  library,
  formDisabled,
  addRoots,
  requestRootMigration,
  toggleRoot,
  requestRootRemoval,
  cancelRootRemoval
}: {
  library: MediaLibraryDetail
  formDisabled: boolean
  addRoots: () => Promise<void>
  requestRootMigration: (root: MediaLibraryRoot) => Promise<void>
  toggleRoot: (root: MediaLibraryRoot) => Promise<void>
  requestRootRemoval: (root: MediaLibraryRoot) => Promise<void>
  cancelRootRemoval: (root: MediaLibraryRoot) => Promise<void>
}): JSX.Element {
  return (
    <div className={styles.sectionStack}>
      <AppFormSection
        title="来源目录"
        hint="每个路径只能归属于一个媒体库；启用的目录会参与该媒体库扫描。"
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={formDisabled}
            onClick={() => void addRoots()}
          >
            <FolderPlus {...UI_ICON_SM} aria-hidden />
            添加目录
          </Button>
        }
      >
        {library.roots.length === 0 ? (
          <EmptyState
            variant="compact"
            title="尚未添加来源目录"
            description="添加后即可扫描本地影片或 STRM 文件。"
          />
        ) : (
          <div className={styles.rootList}>
            {library.roots.map((root) => (
              <div className={styles.rootRow} key={root.id}>
                <span className={styles.rootCopy}>
                  <span
                    className={`${styles.rootPath} copyable-text`}
                    title={root.path}
                  >
                    {root.path}
                  </span>
                  <span className={styles.rootMeta}>
                    <span className={styles.rootState} data-state={root.state}>
                      {ROOT_STATUS_LABELS[root.state]}
                    </span>
                    {root.realPath == null && root.state !== 'archived'
                      ? ' · 当前不可访问'
                      : ''}
                  </span>
                </span>
                <span className={styles.rootActions}>
                  {root.state === 'active' || root.state === 'disabled' ? (
                    <>
                      <Button
                        size="sm"
                        disabled={formDisabled}
                        onClick={() => void requestRootMigration(root)}
                      >
                        迁移
                      </Button>
                      <Button
                        size="sm"
                        disabled={formDisabled}
                        onClick={() => void toggleRoot(root)}
                      >
                        {root.state === 'active' ? '停用' : '启用'}
                      </Button>
                    </>
                  ) : null}
                  {root.state !== 'pending_removal' &&
                  root.state !== 'archived' ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={formDisabled}
                      onClick={() => void requestRootRemoval(root)}
                    >
                      移除
                    </Button>
                  ) : null}
                  {root.state === 'pending_removal' ? (
                    <Button
                      size="sm"
                      disabled={formDisabled}
                      onClick={() => void cancelRootRemoval(root)}
                    >
                      取消移除（保持停用）
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </AppFormSection>
    </div>
  )
}

export function ScanSettingsTab({
  libraryId,
  library,
  scan,
  scanMetrics,
  latestScanSummary,
  pendingScanGroupIds,
  selectedScanMetric,
  setSelectedScanMetric,
  configDraft,
  updateConfigDraft,
  formDisabled,
  saveConfig,
  navigate
}: {
  libraryId: number
  library: MediaLibraryDetail
  scan: ScanController
  scanMetrics: MediaLibraryScanMetrics | null
  latestScanSummary: LibraryScanSummary | null
  pendingScanGroupIds: Set<number>
  selectedScanMetric: LibraryScanMetricKey | null
  setSelectedScanMetric: Dispatch<SetStateAction<LibraryScanMetricKey | null>>
  configDraft: MediaLibraryConfigValues
  updateConfigDraft: UpdateConfigDraft
  formDisabled: boolean
  saveConfig: SaveConfig
  navigate: NavigateFunction
}): JSX.Element {
  return (
    <div className={styles.sectionStack}>
      <AppFormSection
        title="手动扫描"
        hint="只扫描当前媒体库的启用来源；运行中配置使用开始时的固定快照。"
        actions={
          scan.running ? (
            <Button
              size="sm"
              variant="danger"
              disabled={scan.cancelling || !scan.activeRunId}
              onClick={() => void scan.cancel()}
            >
              {scan.cancelling ? '正在取消…' : '取消扫描'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!canRunMediaLibraryScan(library)}
              onClick={() => void scan.start()}
            >
              开始扫描
            </Button>
          )
        }
      >
        {library.activeRootCount === 0 &&
        library.pendingCleanupJobCount === 0 ? (
          <div className={styles.scanNotice} data-tone="warning">
            当前媒体库没有启用的来源目录，请先在“来源”页添加或启用目录。
          </div>
        ) : library.activeRootCount === 0 ? (
          <div className={styles.scanNotice} data-tone="warning">
            当前没有启用的来源目录；本次运行只会完成待移除来源的资源清理。
          </div>
        ) : null}
        {scan.running ? (
          <div className={styles.scanProgress} role="status" aria-live="polite">
            <span className={styles.scanProgressTitle}>
              {scan.cancelling ? '正在请求取消扫描…' : '正在扫描当前媒体库…'}
            </span>
            <span className={styles.scanProgressDetail}>
              {scan.progress
                ? `已扫描 ${scan.progress.scanned} 个文件，新导入 ${scan.progress.imported} 部${scan.progress.currentFile ? ` · ${scan.progress.currentFile}` : ''}`
                : '正在准备目录与资源快照…'}
            </span>
          </div>
        ) : null}
        {scan.error ? (
          <div className={styles.scanNotice} data-tone="danger" role="alert">
            扫描失败：{scan.error}
          </div>
        ) : null}
        {scanMetrics ? (
          <div className={styles.scanSummary}>
            <div className={styles.scanSummaryHead}>
              <span>
                {scan.result ? '本次扫描' : '最近一次扫描'}
                {scanMetrics.cancelled ? '（已取消）' : ''}
              </span>
              {scanMetrics.finishedAt ? (
                <time
                  className={styles.scanSummaryTime}
                  dateTime={scanMetrics.finishedAt}
                >
                  {new Date(scanMetrics.finishedAt).toLocaleString()}
                </time>
              ) : null}
            </div>
            <dl className={styles.scanMetrics}>
              <div className={styles.scanMetric}>
                <dt className={styles.scanMetricLabel}>已扫描</dt>
                <dd className={styles.scanMetricValue}>
                  {scanMetrics.scanned}
                </dd>
              </div>
              <div className={styles.scanMetric}>
                <dt className={styles.scanMetricLabel}>新导入</dt>
                <dd className={styles.scanMetricValue}>
                  {scanMetrics.imported}
                </dd>
              </div>
              <div className={styles.scanMetric}>
                <dt className={styles.scanMetricLabel}>失败</dt>
                <dd className={styles.scanMetricValue}>{scanMetrics.failed}</dd>
              </div>
              <div className={styles.scanMetric}>
                <dt className={styles.scanMetricLabel}>待确认组</dt>
                <dd className={styles.scanMetricValue}>
                  {scanMetrics.pending}
                </dd>
              </div>
              <div className={styles.scanMetric}>
                <dt className={styles.scanMetricLabel}>离线目录</dt>
                <dd className={styles.scanMetricValue}>
                  {scanMetrics.offline}
                </dd>
              </div>
              <div className={styles.scanMetric}>
                <dt className={styles.scanMetricLabel}>未识别文件</dt>
                <dd className={styles.scanMetricValue}>
                  {scanMetrics.unrecognized}
                </dd>
              </div>
            </dl>
            {scanMetrics.errorSummary ? (
              <div
                className={styles.scanNotice}
                data-tone="danger"
                role="alert"
              >
                {scanMetrics.errorSummary}
              </div>
            ) : null}
            {scanMetrics.offlineFolders.length > 0 ? (
              <div
                className={`${styles.scanNotice} copyable-text`}
                data-tone="warning"
              >
                离线目录：{scanMetrics.offlineFolders.join('；')}
              </div>
            ) : null}
            <div className={styles.scanSummaryActions}>
              <Button size="sm" onClick={() => void scan.refreshLatest()}>
                刷新摘要
              </Button>
              {scanMetrics.pending > 0 ? (
                <Button
                  size="sm"
                  onClick={() =>
                    navigate(pendingCenterPath({ type: 'scan', libraryId }))
                  }
                >
                  进入待确认
                </Button>
              ) : null}
            </div>
          </div>
        ) : scan.latestLoading ? (
          <div className={styles.scanNotice}>正在读取最近扫描摘要…</div>
        ) : (
          <div className={styles.scanNotice}>当前媒体库还没有扫描记录。</div>
        )}
      </AppFormSection>
      {latestScanSummary ? (
        <AppFormSection
          title="扫描审计"
          hint="审计、无法识别文件和待确认归属只属于当前媒体库。"
        >
          <LibraryScanAuditPanel
            summary={latestScanSummary}
            audit={scan.latest?.audit ?? null}
            selected={selectedScanMetric}
            unrecognized={scan.latest?.unrecognized ?? []}
            currentPendingGroupIds={pendingScanGroupIds}
            onSelect={setSelectedScanMetric}
            onResolvedUnrecognized={() => {
              void scan.refreshLatest()
            }}
            onOpenVideo={(videoId) =>
              navigate(mediaLibraryVideoDetailPath(libraryId, videoId))
            }
            onOpenPending={(groupId) =>
              navigate(
                pendingCenterPath({
                  type: 'scan',
                  libraryId,
                  item: groupId ? pendingItemKey('scan', groupId) : undefined
                })
              )
            }
          />
        </AppFormSection>
      ) : null}
      {!latestScanSummary && (scan.latest?.unrecognized.length ?? 0) > 0 ? (
        <AppFormSection
          title="无法识别文件"
          hint="这些记录由目录迁移或旧数据恢复产生，仍只属于当前媒体库。"
        >
          <div className={styles.unrecognizedList}>
            {scan.latest!.unrecognized.map((item) => (
              <UnrecognizedRow
                key={`${item.rootId}:${item.filePath}`}
                libraryId={libraryId}
                rootId={item.rootId}
                path={item.filePath}
                onResolved={() => {
                  void scan.refreshLatest()
                }}
              />
            ))}
          </div>
        </AppFormSection>
      ) : null}
      <AppFormSection
        title="扫描计划"
        hint="设置仅作用于当前媒体库，扫描开始后会使用一份固定配置快照。"
      >
        <ToggleRow
          title="自动扫描"
          description="按设定周期检查当前媒体库的启用来源。"
          checked={configDraft.autoScanEnabled}
          disabled={formDisabled}
          onChange={(value) => updateConfigDraft('autoScanEnabled', value)}
        />
        <div className={styles.fieldGrid}>
          <AppFormField label="扫描周期" hint="5–10080 分钟">
            <div className={styles.numberControl}>
              <input
                className={styles.textControl}
                type="number"
                min={5}
                max={10_080}
                step={1}
                value={configDraft.autoScanIntervalMinutes}
                disabled={formDisabled || !configDraft.autoScanEnabled}
                onChange={(event) =>
                  updateConfigDraft(
                    'autoScanIntervalMinutes',
                    Number(event.target.value)
                  )
                }
              />
              <span className={styles.numberUnit}>分钟</span>
            </div>
          </AppFormField>
          <AppFormField
            label="导入最小时长"
            hint="0 表示不限制；最大 1440 分钟"
          >
            <div className={styles.numberControl}>
              <input
                className={styles.textControl}
                type="number"
                min={0}
                max={1_440}
                step={1}
                value={configDraft.minImportDurationMinutes}
                disabled={formDisabled}
                onChange={(event) =>
                  updateConfigDraft(
                    'minImportDurationMinutes',
                    Number(event.target.value)
                  )
                }
              />
              <span className={styles.numberUnit}>分钟</span>
            </div>
          </AppFormField>
        </div>
      </AppFormSection>
      <AppFormSection title="导入与清理策略">
        <ToggleRow
          title="同番号自动合并资源"
          description="同一媒体库扫描到同番号文件时，直接加入现有影片成员。"
          checked={configDraft.autoMergeSameCodeResources}
          disabled={formDisabled}
          onChange={(value) =>
            updateConfigDraft('autoMergeSameCodeResources', value)
          }
        />
        <ToggleRow
          title="清理无资源成员"
          description="安全扫描清理后，移除当前媒体库中不再拥有资源的影片成员。"
          checked={configDraft.removeResourceLessMemberships}
          disabled={formDisabled}
          onChange={(value) =>
            updateConfigDraft('removeResourceLessMemberships', value)
          }
        />
      </AppFormSection>
      <div className={styles.saveRow}>
        <Button
          size="sm"
          variant="primary"
          disabled={formDisabled}
          onClick={() => void saveConfig(SCAN_CONFIG_KEYS, '扫描设置已保存')}
        >
          <Save {...UI_ICON_SM} aria-hidden />
          保存扫描设置
        </Button>
      </div>
    </div>
  )
}

export function ScrapingSettingsTab({
  configDraft,
  updateConfigDraft,
  formDisabled,
  defaultScraper,
  scraperOptions,
  saveConfig
}: {
  configDraft: MediaLibraryConfigValues
  updateConfigDraft: UpdateConfigDraft
  formDisabled: boolean
  defaultScraper: string | null
  scraperOptions: string[]
  saveConfig: SaveConfig
}): JSX.Element {
  return (
    <div className={styles.sectionStack}>
      <AppFormSection
        title="默认影片刮削器"
        hint="该选择仅影响当前媒体库发起的默认刮削动作。"
      >
        <AppFormField label="刮削插件">
          <SelectControl
            value={configDraft.defaultVideoScraper ?? ''}
            disabled={formDisabled}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              updateConfigDraft(
                'defaultVideoScraper',
                event.target.value || null
              )
            }
          >
            <option value="">
              跟随全局默认{defaultScraper ? `（${defaultScraper}）` : ''}
            </option>
            {scraperOptions.map((scraper) => (
              <option key={scraper} value={scraper}>
                {scraper}
              </option>
            ))}
          </SelectControl>
        </AppFormField>
      </AppFormSection>
      <div className={styles.saveRow}>
        <Button
          size="sm"
          variant="primary"
          disabled={formDisabled}
          onClick={() =>
            void saveConfig(SCRAPING_CONFIG_KEYS, '刮削设置已保存')
          }
        >
          <Save {...UI_ICON_SM} aria-hidden />
          保存刮削设置
        </Button>
      </div>
    </div>
  )
}

export function DisplaySettingsTab({
  configDraft,
  updateConfigDraft,
  formDisabled,
  saveConfig
}: {
  configDraft: MediaLibraryConfigValues
  updateConfigDraft: UpdateConfigDraft
  formDisabled: boolean
  saveConfig: SaveConfig
}): JSX.Element {
  return (
    <div className={styles.sectionStack}>
      <AppFormSection
        title="媒体库列表默认值"
        hint="URL 中显式选择的排序仍优先；未指定时使用这里的默认值。"
      >
        <div className={styles.fieldGrid}>
          <AppFormField label="默认排序">
            <SelectControl
              value={configDraft.defaultSortBy}
              disabled={formDisabled}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                updateConfigDraft(
                  'defaultSortBy',
                  event.target
                    .value as MediaLibraryConfigValues['defaultSortBy']
                )
              }
            >
              {MEDIA_LIBRARY_DEFAULT_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {
                    {
                      add_time: '添加时间',
                      release_date: '发行日期',
                      rating: '评分',
                      code: '番号'
                    }[sort]
                  }
                </option>
              ))}
            </SelectControl>
          </AppFormField>
          <AppFormField label="默认方向">
            <SelectControl
              value={configDraft.defaultSortDir}
              disabled={formDisabled}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                updateConfigDraft(
                  'defaultSortDir',
                  event.target
                    .value as MediaLibraryConfigValues['defaultSortDir']
                )
              }
            >
              <option value="desc">降序</option>
              <option value="asc">升序</option>
            </SelectControl>
          </AppFormField>
        </div>
      </AppFormSection>
      <AppFormSection title="首页发现">
        <ToggleRow
          title="参与随机推荐和近期添加"
          description="关闭后，当前媒体库不会出现在首页影片发现结果中。"
          checked={configDraft.includeInHomeDiscovery}
          disabled={formDisabled}
          onChange={(value) =>
            updateConfigDraft('includeInHomeDiscovery', value)
          }
        />
      </AppFormSection>
      <div className={styles.saveRow}>
        <Button
          size="sm"
          variant="primary"
          disabled={formDisabled}
          onClick={() => void saveConfig(DISPLAY_CONFIG_KEYS, '显示设置已保存')}
        >
          <Save {...UI_ICON_SM} aria-hidden />
          保存显示设置
        </Button>
      </div>
    </div>
  )
}

export function MaintenanceSettingsTab({
  library,
  archived,
  busy,
  restoreLibrary,
  setLifecycleConfirm,
  openDeleteConfirmation
}: {
  library: MediaLibraryDetail
  archived: boolean
  busy: string | null
  restoreLibrary: () => Promise<void>
  setLifecycleConfirm: Dispatch<SetStateAction<'archive' | null>>
  openDeleteConfirmation: () => Promise<void>
}): JSX.Element {
  const lifecycle = mediaLibraryLifecycleCapabilities(library)
  return (
    <div className={styles.sectionStack}>
      {library.isDefault ? (
        <div className={styles.protectedNotice}>
          默认媒体库受保护，不能归档或永久删除。
        </div>
      ) : null}
      <section className={styles.lifecycleRow}>
        <span className={styles.lifecycleCopy}>
          <strong className={styles.lifecycleTitle}>
            {archived ? '恢复媒体库' : '归档媒体库'}
          </strong>
          <span className={styles.lifecycleDescription}>
            {archived
              ? '恢复后会重新校验来源目录身份，并重新出现在侧栏和全局结果中。'
              : '归档会暂停扫描并从普通导航中隐藏，目录与影片数据仍保留。'}
          </span>
        </span>
        {archived ? (
          <Button
            size="sm"
            disabled={!lifecycle.canRestore || busy !== null}
            onClick={() => void restoreLibrary()}
          >
            <RefreshCw {...UI_ICON_SM} aria-hidden />
            恢复
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!lifecycle.canArchive || busy !== null}
            onClick={() => setLifecycleConfirm('archive')}
          >
            <Archive {...UI_ICON_SM} aria-hidden />
            归档
          </Button>
        )}
      </section>
      <section className={`${styles.lifecycleRow} ${styles.dangerRow}`}>
        <span className={styles.lifecycleCopy}>
          <strong className={styles.lifecycleTitle}>永久删除媒体库</strong>
          <span className={styles.lifecycleDescription}>
            仅归档后可用。该操作删除媒体库配置与成员关系，无法撤销。
          </span>
        </span>
        <Button
          size="sm"
          variant="danger"
          disabled={!lifecycle.canDelete || busy !== null}
          onClick={() => void openDeleteConfirmation()}
        >
          <Trash2 {...UI_ICON_SM} aria-hidden />
          永久删除
        </Button>
      </section>
    </div>
  )
}
