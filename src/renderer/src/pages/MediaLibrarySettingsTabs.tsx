import type { Dispatch, SetStateAction, ChangeEvent } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import {
  AlertTriangle,
  Archive,
  Clock,
  FolderOpen,
  FolderPlus,
  Play,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Square,
  Trash2
} from 'lucide-react'
import { AUTO_SCAN_INTERVAL_MINUTES } from '@shared/settingsTypes'
import type {
  LibraryScanLatestSnapshot,
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
import { AppFormField, AppFormSection } from '../components/FormPrimitives'
import { UI_ICON_SM } from '../components/iconDefaults'
import { NavIcon } from '../components/NavIcons'
import SelectControl from '../components/SelectControl'
import SettingsSwitchRow from '../components/SettingsSwitchRow'
import Switch from '../components/Switch'
import LibraryScanAuditPanel from '../components/settings/LibraryScanAuditPanel'
import {
  SettingsEmptyPanel,
  SettingsNumberStepper,
  SettingsSectionBlock,
  SettingsStatusPill
} from '../components/settings/SettingsPrimitives'
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
import { api } from '../api'

const SCAN_TRIGGER_LABEL: Record<LibraryScanSummary['trigger'], string> = {
  manual: '手动',
  startup: '启动后',
  interval: '定时',
  resume: '唤醒后'
}

const SCAN_STATUS_LABEL: Record<LibraryScanSummary['status'], string> = {
  success: '成功',
  completed_with_errors: '完成但有失败项',
  cancelled: '已取消',
  failed: '失败'
}

function formatScanTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false })
}

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

type UpdateConfigImmediately = <Key extends keyof MediaLibraryConfigValues>(
  key: Key,
  value: MediaLibraryConfigValues[Key]
) => Promise<void>

type ScanController = ReturnType<typeof useMediaLibraryScanController>

function ScanHistorySummary({
  summary,
  audit,
  selected,
  unrecognized,
  currentPendingGroupIds,
  onSelect,
  onResolvedUnrecognized,
  onOpenPending,
  onOpenVideo
}: {
  summary: LibraryScanSummary
  audit: LibraryScanLatestSnapshot['audit']
  selected: LibraryScanMetricKey | null
  unrecognized: LibraryScanLatestSnapshot['unrecognized']
  currentPendingGroupIds: Set<number>
  onSelect: (key: LibraryScanMetricKey | null) => void
  onResolvedUnrecognized: (path: string) => void
  onOpenPending: (groupId?: number) => void
  onOpenVideo: (videoId: number) => void
}): JSX.Element {
  return (
    <div className={styles.scanHistorySummary}>
      <div className={styles.scanHistorySummaryHead}>
        <div>
          <strong>{SCAN_TRIGGER_LABEL[summary.trigger]}扫描</strong>
          <span>
            {formatScanTime(summary.startedAt)} 至 {formatScanTime(summary.finishedAt)}
          </span>
        </div>
        <SettingsStatusPill
          status={
            summary.status === 'failed' ||
            summary.status === 'completed_with_errors'
              ? 'warning'
              : summary.status
          }
        >
          {SCAN_STATUS_LABEL[summary.status]}
        </SettingsStatusPill>
      </div>
      <LibraryScanAuditPanel
        summary={summary}
        audit={audit}
        selected={selected}
        unrecognized={unrecognized}
        currentPendingGroupIds={currentPendingGroupIds}
        onSelect={onSelect}
        onResolvedUnrecognized={onResolvedUnrecognized}
        onOpenPending={onOpenPending}
        onOpenVideo={onOpenVideo}
      />
      {summary.offlineFolders.length > 0 ? (
        <div className={`${styles.scanHistoryDetail} ${styles.warningDetail}`}>
          <strong>{summary.offlineFolders.length} 个离线目录</strong>
          {summary.offlineFolders.map((folder) => (
            <div className={styles.scanHistoryPathDetail} key={folder}>
              <span className="copyable-text" title={folder}>
                {folder}
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(folder)}
              >
                复制路径
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  void api.scan.revealAuditFile(summary.libraryId, folder)
                }
              >
                在文件夹中显示
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {(summary.strmFailures?.length ?? 0) > 0 ||
      (summary.omittedStrmFailures ?? 0) > 0 ? (
        <div className={`${styles.scanHistoryDetail} ${styles.warningDetail}`}>
          <strong>STRM 失败项</strong>
          {summary.strmFailures?.map((failure) => (
            <span
              className="copyable-text"
              key={`${failure.sourcePath}:${failure.code}`}
            >
              {failure.sourcePath} · {failure.message}
            </span>
          ))}
          {(summary.omittedStrmFailures ?? 0) > 0 ? (
            <span>另有 {summary.omittedStrmFailures} 项未显示</span>
          ) : null}
        </div>
      ) : null}
      {summary.errorSummary ? (
        <div className={`${styles.scanHistoryDetail} ${styles.errorDetail}`}>
          <strong>错误摘要</strong>
          <span className="copyable-text">{summary.errorSummary}</span>
        </div>
      ) : null}
    </div>
  )
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

export function OverviewSettingsTab({
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
        title="身份与侧栏显示"
        hint="名称、图标、颜色和排序用于识别当前媒体库，不会改变库内影片数据。"
      >
        <AppFormField label="媒体库名称">
          <input
            className={`text-input ${styles.textControl}`}
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
            className={`text-input ${styles.textControl}`}
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
          保存媒体库身份
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
    <section className={styles.sourcePanel} aria-label="来源目录">
      <div className={styles.sourcePanelHead}>
        <div className={styles.sourcePanelTitle}>
          <span className={styles.sourcePanelIcon} aria-hidden="true">
            <FolderOpen {...UI_ICON_SM} />
          </span>
          <div>
            <h4>来源目录</h4>
            <p>每个路径只归属于一个媒体库；启用的目录会参与扫描。</p>
          </div>
        </div>
        <Button
          size="sm"
          disabled={formDisabled}
          onClick={() => void addRoots()}
        >
          <FolderPlus {...UI_ICON_SM} aria-hidden />
          添加目录
        </Button>
      </div>
      {library.roots.length === 0 ? (
        <SettingsEmptyPanel variant="dashed" className={styles.sourceEmpty}>
          尚未添加来源目录
        </SettingsEmptyPanel>
      ) : (
        <div className={styles.rootList}>
          {library.roots.map((root) => (
            <div className={styles.rootRow} key={root.id}>
              <FolderOpen
                className={styles.rootIcon}
                {...UI_ICON_SM}
                aria-hidden
              />
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
    </section>
  )
}

export function ScanSettingsTab({
  libraryId,
  library,
  scan,
  latestScanSummary,
  pendingScanGroupIds,
  selectedScanMetric,
  setSelectedScanMetric,
  configDraft,
  updateConfigImmediately,
  formDisabled,
  navigate
}: {
  libraryId: number
  library: MediaLibraryDetail
  scan: ScanController
  latestScanSummary: LibraryScanSummary | null
  pendingScanGroupIds: Set<number>
  selectedScanMetric: LibraryScanMetricKey | null
  setSelectedScanMetric: Dispatch<SetStateAction<LibraryScanMetricKey | null>>
  configDraft: MediaLibraryConfigValues
  updateConfigImmediately: UpdateConfigImmediately
  formDisabled: boolean
  navigate: NavigateFunction
}): JSX.Element {
  const scanStatus = scan.running
    ? scan.progress
      ? `已扫描 ${scan.progress.scanned} 个文件，新导入 ${scan.progress.imported} 部${scan.progress.currentFile ? ` · ${scan.progress.currentFile}` : ''}`
      : '正在准备目录与资源快照…'
    : scan.error
      ? `扫描失败：${scan.error}`
      : ''

  return (
    <>
      <section
        className={`${styles.scanConsole}${scan.running ? ` ${styles.scanConsoleScanning}` : ''}`}
        aria-label="扫描导入"
      >
        <div className={styles.scanPanelHead}>
          <div className={styles.scanPanelTitle}>
            <span className={styles.scanPanelIcon} aria-hidden="true">
              {scan.running ? (
                <Square {...UI_ICON_SM} />
              ) : (
                <Play {...UI_ICON_SM} />
              )}
            </span>
            <div>
              <h4>扫描导入</h4>
              <p>导入新影片、同步路径变动并清理失效记录。</p>
            </div>
          </div>
        </div>

        <div className={styles.scanCommandRow}>
          <Button
            type="button"
            variant={scan.running ? 'default' : 'primary'}
            disabled={
              scan.running
                ? scan.cancelling || !scan.activeRunId
                : formDisabled || !canRunMediaLibraryScan(library)
            }
            title={
              !scan.running && !canRunMediaLibraryScan(library)
                ? '请先添加或启用来源目录'
                : undefined
            }
            onClick={() => void (scan.running ? scan.cancel() : scan.start())}
          >
            {scan.running ? (
              <Square {...UI_ICON_SM} aria-hidden />
            ) : (
              <Play {...UI_ICON_SM} aria-hidden />
            )}
            {scan.running
              ? scan.cancelling
                ? '正在取消…'
                : '取消扫描'
              : library.activeRootCount > 0
                ? '扫描并导入'
                : '执行待清理'}
          </Button>
          <div className={styles.scanDuration}>
            <span className={styles.scanDurationLabel}>
              <Clock {...UI_ICON_SM} aria-hidden />
              最短时长
            </span>
            <SettingsNumberStepper
              aria-label="最短导入时长（分钟）"
              value={configDraft.minImportDurationMinutes}
              min={0}
              max={600}
              step={1}
              unit="分钟"
              disabled={formDisabled}
              onChange={(value) =>
                void updateConfigImmediately('minImportDurationMinutes', value)
              }
            />
          </div>
        </div>

        <div className={styles.scanMessageRow}>
          <span className={styles.scanNote}>
            {configDraft.minImportDurationMinutes > 0
              ? `自动跳过不足 ${configDraft.minImportDurationMinutes} 分钟的本地视频；STRM 不受时长过滤影响`
              : '未启用本地视频时长过滤；STRM 始终参与扫描'}
          </span>
          {scanStatus ? (
            <span className={styles.scanStatus} role="status" aria-live="polite">
              {scanStatus}
            </span>
          ) : null}
        </div>
        <section
          className={styles.scanHistory}
          aria-labelledby="library-last-scan-title"
        >
          <div className={styles.scanHistoryHead}>
            <h5 id="library-last-scan-title">最近一次扫描</h5>
            <span>只保留最近一次手动或后台扫描的审计摘要。</span>
          </div>
          {latestScanSummary ? (
            <ScanHistorySummary
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
                    item: groupId
                      ? pendingItemKey('scan', groupId)
                      : undefined
                  })
                )
              }
            />
          ) : (
            <SettingsEmptyPanel variant="compact">尚无扫描记录</SettingsEmptyPanel>
          )}
        </section>
      </section>
      <section className={styles.scanSettingsPanel} aria-label="扫描设置">
        <div className={styles.scanSettingsPanelHead}>
          <div className={styles.scanSettingsPanelTitle}>
            <span className={styles.scanSettingsPanelIcon} aria-hidden="true">
              <SlidersHorizontal {...UI_ICON_SM} />
            </span>
            <div>
              <h4>扫描设置</h4>
              <p>配置资源归属、自动扫描与扫描后的清理策略。</p>
            </div>
          </div>
        </div>
        <SettingsSectionBlock
          className={styles.scanSettingsBlock}
          title="资源归属"
          hint="只影响之后扫描发现的新资源；不会自动处理已有待确认组。"
        >
          <div className="settings-toggle-list settings-toggle-list--compact">
            <SettingsSwitchRow
              title="同番号自动合并资源"
              description="同一媒体库扫描到同番号文件时，直接加入现有影片成员。"
              checked={configDraft.autoMergeSameCodeResources}
              disabled={formDisabled}
              onChange={(value) =>
                void updateConfigImmediately('autoMergeSameCodeResources', value)
              }
            />
          </div>
        </SettingsSectionBlock>
        <SettingsSectionBlock
          className={styles.scanSettingsBlock}
          title="自动扫描"
          hint="应用启动、系统唤醒及运行期间会检查是否已达到扫描间隔。"
        >
          <div className="settings-toggle-list settings-toggle-list--compact">
            <SettingsSwitchRow
              title="按固定间隔自动扫描媒体库"
              description="默认关闭；开启后不会立即扫描"
              checked={configDraft.autoScanEnabled}
              disabled={formDisabled}
              onChange={(value) =>
                void updateConfigImmediately('autoScanEnabled', value)
              }
            />
          </div>
          <label
            className={`${styles.scanAutoInterval}${configDraft.autoScanEnabled ? '' : ` ${styles.scanAutoIntervalDisabled}`}`}
          >
            <span>
              <strong>扫描间隔</strong>
              <small>以上一次扫描完成时间为起点</small>
            </span>
            <SelectControl
              className={styles.scanIntervalSelect}
              aria-label="自动扫描间隔"
              value={configDraft.autoScanIntervalMinutes}
              disabled={formDisabled || !configDraft.autoScanEnabled}
              onChange={(event) =>
                void updateConfigImmediately(
                  'autoScanIntervalMinutes',
                  Number(event.target.value)
                )
              }
            >
              {AUTO_SCAN_INTERVAL_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}
                </option>
              ))}
            </SelectControl>
          </label>
        </SettingsSectionBlock>
        <SettingsSectionBlock
          className={styles.scanSettingsBlock}
          title="扫描后清理"
          hint="只在完整扫描成功且所有目录在线时执行。"
        >
          <div className="settings-toggle-list settings-toggle-list--compact">
            <SettingsSwitchRow
              title="扫描后自动清理无资源成员"
              description="仅移除当前媒体库中的成员关系，不会删除媒体目录中的源文件；仍被任一清单引用的影片会保留，不会被自动清理"
              checked={configDraft.removeResourceLessMemberships}
              disabled={formDisabled}
              onChange={(value) =>
                void updateConfigImmediately('removeResourceLessMemberships', value)
              }
            />
          </div>
          <div className={styles.scanCleanupNotice}>
            <AlertTriangle {...UI_ICON_SM} aria-hidden />
            <span className={styles.scanCleanupCopy}>
              <strong>成员清理</strong>
              <span>扫描失败、取消或存在离线目录时不会执行清理。</span>
            </span>
          </div>
        </SettingsSectionBlock>
      </section>
    </>
  )
}

type SourcesSettingsProps = Parameters<typeof SourcesSettingsTab>[0]
type ScanSettingsProps = Parameters<typeof ScanSettingsTab>[0]

export function SourcesAndScanSettingsTab(
  props: SourcesSettingsProps & ScanSettingsProps
): JSX.Element {
  return (
    <div className={styles.importWorkspace}>
      <SourcesSettingsTab {...props} />
      <ScanSettingsTab {...props} />
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
  requestArchive,
  restoreLibrary,
  openDeleteConfirmation
}: {
  library: MediaLibraryDetail
  archived: boolean
  busy: string | null
  requestArchive: () => void
  restoreLibrary: () => Promise<void>
  openDeleteConfirmation: () => Promise<void>
}): JSX.Element {
  const lifecycle = mediaLibraryLifecycleCapabilities(library)
  return (
    <div className={styles.sectionStack}>
      {library.isDefault ? (
        <div className={styles.protectedNotice}>
          此媒体库受系统保护，不能归档或永久删除。
        </div>
      ) : (
        <>
          <section className={styles.lifecycleRow}>
            <span className={styles.lifecycleCopy}>
              <strong className={styles.lifecycleTitle}>
                {archived ? '恢复媒体库' : '归档媒体库'}
              </strong>
              <span className={styles.lifecycleDescription}>
                {archived
                  ? '恢复后重新校验来源目录，并重新显示在普通导航中。'
                  : '停止扫描并从普通导航中隐藏；归档后仍可恢复。'}
              </span>
            </span>
            <Button
              size="sm"
              variant={archived ? 'primary' : undefined}
              disabled={
                busy !== null ||
                (archived ? !lifecycle.canRestore : !lifecycle.canArchive)
              }
              onClick={() =>
                archived ? void restoreLibrary() : requestArchive()
              }
            >
              {archived ? (
                <RefreshCw {...UI_ICON_SM} aria-hidden />
              ) : (
                <Archive {...UI_ICON_SM} aria-hidden />
              )}
              {archived ? '恢复媒体库' : '归档媒体库'}
            </Button>
          </section>
          {archived ? (
            <section className={`${styles.lifecycleRow} ${styles.dangerRow}`}>
              <span className={styles.lifecycleCopy}>
                <strong className={styles.lifecycleTitle}>永久删除媒体库</strong>
                <span className={styles.lifecycleDescription}>
                  删除媒体库配置与成员关系，无法撤销。
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
          ) : null}
        </>
      )}
    </div>
  )
}
