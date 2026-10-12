import TextInput from '../../apps/desktop/src/renderer/src/components/TextInput'
import './avatar-worker-adapter'
import TextArea from '../../apps/desktop/src/renderer/src/components/TextArea'
import React, { useContext, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Clapperboard, FolderOpen, Palette, Settings, Wifi } from 'lucide-react'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.api = {
  actresses: {
    mergeCandidates: async ({ search = '', offset = 0, limit = 40 }) => {
      const page = new URLSearchParams(location.search).get('page')
      if (page === 'actressMergeError') throw new Error('候选查询暂时失败')
      const items = page === 'actressMergeEmpty' ? [] : Array.from({ length: 20 }, (_, index) => ({ id: index + 2,
        main_name: `候选演员${index + 2}`, gender: 'female', avatar_path: null, video_count: index + 1 }))
        .filter(item => item.main_name.includes(search))
      return { items: items.slice(offset, offset + limit), offset, hasMore: items.length > offset + limit }
    },
    merge: async (input, version) => { window.lastActressMerge = { input, version }; throw new Error('合并失败：测试长路径 /fixture/actors/候选演员/资料暂时不可用，请重试。') },
    videoPage: async () => ({ videos: [], total: 0, limit: 60, offset: 0 }),
    galleryPage: async (_id, { offset = 0, limit = 60, localOnly } = {}) => {
      const page = new URLSearchParams(location.search).get('page')
      if (!['galleryPaging', 'avatarGalleryPaging'].includes(page)) return { items: [], total: 0, limit: 60, offset: 0 }
      window.lastGalleryQuery = { offset, limit, localOnly }
      return { items: Array.from({ length: Math.min(limit, 121 - offset) }, (_, i) => ({
        id: offset + i + 1, local_path: 'fixture-gallery.svg', remote_url: null, width: 100, height: 100
      })), total: 121, limit, offset }
    },
    testTargetPage: async ({ search = '', offset = 0, limit = 40 }) => {
      const items = [{ id: 1, main_name: '测试演员甲', avatar_path: null }, { id: 2, main_name: '测试演员乙', avatar_path: null }]
        .filter(item => item.main_name.includes(search))
      return { items: items.slice(offset, offset + limit), offset, hasMore: items.length > offset + limit }
    },
    testTargetGet: async id => id === 1 ? '测试演员甲' : '测试演员乙',
    deletePreview: async () => ({ actressCount: 1, linkedActressCount: 1, affectedVideoCount: 8 })
  },
  videos: {
    list: async (_scope, { search = '' } = {}) => {
      const items = [
        { id: 1, code: 'ABC-123', title: '视觉验收影片：较长的影片标题用于测试截断效果', release_date: '2026-09-20', poster_path: null, cover_path: null },
        { id: 2, code: 'XYZ-456', title: '第二部测试影片', release_date: null, poster_path: null, cover_path: null }
      ].filter(item => `${item.code} ${item.title}`.toLowerCase().includes(search.toLowerCase()))
      return { items, total: items.length }
    }
  },
  tags: {
    filterOptions: async ({ search }) => ({ items: search ? [] : [{ id: 1, label: '示例标签', video_count: 3 }], hasMore: false }),
    labels: async ids => ids.map(id => ({ id, label: '示例标签' })),
    manualOptions: async () => ({ items: [{ id: 4, label: '候选标签' }, { id: 5, label: '另一候选标签' }], hasMore: false })
  },
  assets: { fetchRemoteImagePreview: async () => ({ mimeType: 'image/svg+xml', dataBase64: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>') }), getPathForFile: () => '/fixture-cover.svg' },
  assetCrypto: { onProgress: callback => {
    window.emitAssetProgress = callback
    return () => { delete window.emitAssetProgress }
  } },
  settings: {
    get: async () => ({ coverDisplayMode: 'portrait', showVideoResourceTypeBadges: false }),
    getOverviewStats: async () => window.fixtureOverviewEmpty
      ? { videos: { total: 0, scraped: 0, unscraped: 0, failed: 0 }, actresses: { total: 0, female: 0, male: 0, scraped: 0, unscraped: 0, failed: 0 }, playlists: 0, tags: 0, galleryAssets: 0, facets: { directors: 0, makers: 0, publishers: 0, series: 0 } }
      : { videos: { total: 120, scraped: 72, unscraped: 40, failed: 8 }, actresses: { total: 90, female: 70, male: 20, scraped: 40, unscraped: 25, failed: 5 }, playlists: 3, tags: 8, galleryAssets: 14, facets: { directors: 5, makers: 4, publishers: 2, series: 6 } },
    getModelManagement: async () => ({ connections: [], models: [], validationErrors: [], assignments: [] })
  },
  webAccess: { status: async () => ({ enabled: true, running: true, port: 8096, username: 'viewer', hasPassword: true, urls: ['http://127.0.0.1:8096'], devices: [], pairingUntil: 0, pairingActivity: [], sessions: 1, error: null }) },
  playlists: { listPage: async ({ offset = 0 }) => ({ offset, limit: 60, total: 2, hasExactName: false,
    items: [{ id: 1, name: '带封面清单', description: '测试', preview_cover_path: null, video_count: 8, contains_video: false },
      { id: 2, name: '无封面清单', description: null, preview_cover_path: null, video_count: 0, contains_video: true }] }),
    metadata: async id => ({ id, generation: 1, revision: 1, name: '视觉验收清单', description: '这是清单说明。', cover_path: null,
      preview_cover_path: null, links: [], created_at: '2026', updated_at: null }),
    videoPage: async () => ({ videos: [], total: 0, filteredTotal: 0, offset: 0, limit: 60 }) },
  playlistImport: { onSnapshotChanged: () => () => {} },
  home: { load: async () => ({ recent: [], discovery: [], libraries: [] }), search: async () => ({ items: [], total: 0 }) },
  mediaLibraries: { list: async () => [] },
  appUpdate: {
    getState: async () => ({ status: 'available', currentVersion: '0.8.0', checkedAt: '2026-09-29T08:00:00Z',
      ignoredVersion: new URLSearchParams(location.search).get('page') === 'appUpdateIgnored' ? '0.8.1' : undefined,
      latestRelease: {
      version: '0.8.1', tagName: 'v0.8.1', releaseName: 'Javdex 0.8.1', releaseUrl: 'https://example.com/release',
      publishedAt: '2026-09-29T08:00:00Z', releaseNotes: new URLSearchParams(location.search).get('page') === 'appUpdateIgnored'
        ? '## 更新内容\n\n修复媒体库设置页的显示。' : '修复媒体库设置页的显示。'
    } }),
    onStateChanged: () => () => {},
    check: async () => ({ status: 'up-to-date', currentVersion: '0.8.0' }),
    ignoreVersion: async () => {},
    openRelease: async () => {}
  },
  externalLinks: { open: async url => { window.lastOpenedLink = url } }
}
const { default: DetailOperationsFixture } = await import('./detail-operations-fixture')
const { AvatarAutoCropBatchStateProvider } = await import('../../apps/desktop/src/renderer/src/contexts/AvatarAutoCropBatchContext')
const { default: SettingsDensityFixture } = await import('./settings-density-fixture')
const { default: NativeEditorsFixture } = await import('./native-editors-fixture')
const { default: HomePage } = await import('../../apps/desktop/src/renderer/src/pages/HomePage')
const { default: GlobalSearchPage } = await import('../../apps/desktop/src/renderer/src/pages/GlobalSearchPage')
const { SegmentedControl, SegmentedOption } = await import('../../apps/desktop/src/renderer/src/components/SegmentedControl')
const { default: SelectControl } = await import('../../apps/desktop/src/renderer/src/components/SelectControl')
const { default: SelectionToolbar } = await import('../../apps/desktop/src/renderer/src/components/SelectionToolbar')
const { default: Button } = await import('../../apps/desktop/src/renderer/src/components/Button')
const actressPageStyles = (await import('../../apps/desktop/src/renderer/src/pages/ActressesPage.module.css')).default
const { default: SortSwitch } = await import('../../apps/desktop/src/renderer/src/components/SortSwitch')
const { default: FilterTrigger } = await import('../../apps/desktop/src/renderer/src/components/FilterTrigger')
const { default: ActressFilterPopover } = await import('../../apps/desktop/src/renderer/src/components/ActressFilterPopover')
const { default: LibraryFilterPopover } = await import('../../apps/desktop/src/renderer/src/components/LibraryFilterPopover')
const { default: ListDetailShell } = await import('../../apps/desktop/src/renderer/src/components/ListDetailShell')
const { default: RelatedLinksEditor } = await import('../../apps/desktop/src/renderer/src/components/RelatedLinksEditor')
const { default: VideoResourceImportModal } = await import('../../apps/desktop/src/renderer/src/components/VideoResourceImportModal')
const { DesktopSessionContext } = await import('../../apps/desktop/src/renderer/src/desktop/DesktopSessionContext')
function ResourceImportFixture({ variant }) {
  const sessionContext = useContext(DesktopSessionContext)
  const resource = {
    id: 11, library_id: 3, video_id: 1, root_id: null, kind: 'direct',
    locator: 'https://cdn.example/ABC-123.mp4', resource_key: 'fixture-resource', source_identity: 'fixture-resource',
    strm_source_path: variant === 'resourceImportStrm' ? '/fixture/长目录/ABC-123.strm' : null,
    size_bytes: 2147483648, duration_seconds: null, file_mtime_ms: null, display_name: '已有资源', is_primary: 1, add_time: '2026'
  }
  window.api.videos.checkResourceLink = async url => {
    window.lastResourceProbe = url
    return new Promise(resolve => { window.resolveResourceProbe = resolve })
  }
  const submit = async input => {
    window.lastResourceSubmit = input
    return new Promise((resolve, reject) => {
      window.resolveResourceSubmit = resolve
      window.rejectResourceSubmit = reject
    })
  }
  window.api.videos.importLinkResource = submit
  window.api.videos.updateLinkResource = async (libraryId, videoId, resourceId, input) => submit({ libraryId, videoId, resourceId, ...input })
  const libraryImport = ['resourceImportLibrary', 'resourceImportRemote'].includes(variant)
  return <DesktopSessionContext.Provider value={variant === 'resourceImportRemote'
    ? { ...sessionContext, session: { ...sessionContext.session, mode: 'remote' } } : sessionContext}>
    <VideoResourceImportModal libraryId={3} fixedCode={libraryImport ? undefined : 'ABC-123'}
      fixedVideoId={variant === 'resourceImportSingle' ? 1 : undefined}
      resource={['resourceImportEdit', 'resourceImportStrm'].includes(variant) ? resource : undefined}
      onCancel={() => { window.resourceImportCancelled = true }}
      onImported={result => { window.completedResourceImport = result }}
      onUpdated={result => { window.completedResourceImport = result }} />
  </DesktopSessionContext.Provider>
}
const { default: Checkbox } = await import('../../packages/ui/src/Checkbox')
const { default: PendingActressConflictPane } = await import('../../apps/desktop/src/renderer/src/pages/PendingActressConflictPane')
const { default: ConflictMergeActressesModal } = await import('../../apps/desktop/src/renderer/src/pages/ConflictMergeActressesModal')
const { default: ClassificationMergeModal } = await import('../../apps/desktop/src/renderer/src/components/ClassificationMergeModal')
const { default: DirectorScrapeChoiceModal } = await import('../../apps/desktop/src/renderer/src/components/DirectorScrapeChoiceModal')
const { default: MergeActressModal } = await import('../../apps/desktop/src/renderer/src/components/MergeActressModal')
function ClassificationMergeFixture({ state = 'ready' }) {
  const items = Array.from({ length: 8 }, (_, index) => ({ id: index + 2, mainName: `候选导演${index + 2}`, videoCount: index + 1 }))
  return <ClassificationMergeModal title="合并导演" hint="选择另一位导演并入当前资料，影片关联会保留。" entityLabel="导演" sourceNoun="导演" candidateCountUnit="位"
    target={{ id: 1, mainName: '当前导演', videoCount: 12 }} queryKey={search => ['fixture-merge', state, search]}
    listCandidates={async search => { if (state === 'error') throw new Error('候选读取失败，请稍后重试。'); return state === 'empty' ? [] : items.filter(item => item.mainName.includes(search)) }}
    merge={async input => { window.lastClassificationMerge = input; throw new Error('合并失败：目标资料暂时不可用，请重试。') }}
    renderIcon={() => <Clapperboard size={16} aria-hidden />} targetMeta={item => `${item.videoCount} 部影片`} sourceMeta={item => `${item.videoCount} 部影片`}
    candidateMeta={() => '用于测试资料候选和文本截断'} renderPlan={() => <li>保留目标资料，迁入影片关联并删除来源。</li>}
    onCancel={() => {}} onMerged={() => {}} />
}
function DirectorChoiceFixture() {
  const [busy, setBusy] = useState(false)
  return <DirectorScrapeChoiceModal choice={{ scrapedName: '同名导演', candidates: [
    { id: 18, mainName: '导演甲', aliases: ['同名导演', '另一别名'], description: 'JP · 出生 1960-01-01 · 4 部影片' },
    { id: 29, mainName: '导演乙', aliases: [], description: 'US · 出生 1980-01-01 · 2 部影片' }
  ] }} busy={busy} onCancel={() => {}} onChoose={id => { window.lastDirectorChoice = id; setBusy(true) }} />
}
function ActressMergeFixture() {
  return <MergeActressModal keepActress={{ id: 1, generation: 1, revision: 2, main_name: '当前演员', gender: 'female', avatar_path: null, gallery_count: 3 }}
    keepVideoCount={12} onCancel={() => {}} onMerged={() => {}} />
}
const conflictFixtureActors = [
  { actressId: 1, revision: 2, mainName: '测试演员甲', avatarPath: null, hasPending: true, blockedPartnerReasons: {} },
  { actressId: 2, revision: 3, mainName: '测试演员乙', avatarPath: null, hasPending: false, blockedPartnerReasons: {} }
]
function ConflictMergeFixture({ blocked = false }) {
  const [busy, setBusy] = useState(false)
  return <ConflictMergeActressesModal actors={blocked ? conflictFixtureActors.map(actor => ({ ...actor, hasPending: true })) : conflictFixtureActors}
    busy={busy} onConfirm={decision => { window.lastConflictMerge = decision; setBusy(true) }} onCancel={() => {}} />
}
function ActressConflictFixture() {
  const [tab, setTab] = useState('process')
  const [source, setSource] = useState({ kind: 'scrape', id: 11 })
  const [owner, setOwner] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [editValue, setEditValue] = useState('共享名称')
  const [search, setSearch] = useState('')
  const [otherSelected, setOtherSelected] = useState(null)
  const [replacementName, setReplacementName] = useState('')
  const candidate = {
    pendingId: 11, revision: 1, actressId: 1, actressRevision: 2, actressMainName: '测试演员甲', actressAvatarPath: null,
    plugin: { name: '测试插件', source: 'builtin' }, queryName: '共享名称', selectedFields: ['aliases'], applicableFields: ['aliases'], mode: 'fillEmpty',
    result: { mainName: '测试演员甲', aliases: ['共享名称'], nationality: '日本', profileSummary: '用于核对来源详情换行与长文本的测试资料。' },
    warnings: ['本次资料需要先确认名称归属。'], createdAt: '2026', resources: [],
    conflicts: [{ name: '共享名称', normalizedName: '共享名称', type: 'alias' }],
    fieldImpacts: [], fieldImpactsWhenAssignedToCandidate: [], willApplyAfterDecision: true, remainingConflictCountAfterDecision: 0
  }
  const claim = { claimId: 21, actressId: 2, name: '共享名称', type: 'alias', locale: 'zh', source: '数据库迁移', isPrimary: false }
  const claimant = { actressId: 2, revision: 3, mainName: '测试演员乙', avatarPath: null, nameTypes: ['alias'], hasPendingScrape: false }
  const group = { status: 'conflict', normalizedName: '共享名称', displayName: '共享名称', currentOwner: claimant,
    claimants: [claimant], pendingNameClaims: [claim], candidates: [candidate] }
  const others = [3, 4, 5].map(id => ({ id, main_name: `其他演员${id}`, avatar_path: null })).filter(item => item.main_name.includes(search))
  const close = () => setDialog(null)
  const selectOwner = value => setOwner(value)
  const vm = {
    queue: { selectedGroup: group, staleMessage: null }, busy: { resolving: false },
    detail: { selection: { tab, source }, selectedCandidate: source.kind === 'scrape' ? candidate : null,
      selectedClaim: source.kind === 'claim' ? claim : null,
      ownerOptions: conflictFixtureActors.map(actor => ({ ...actor, roles: [actor.actressId === 1 ? '待确认结果' : '当前名称归属'] })),
      mergeActors: conflictFixtureActors, proposedOwner: owner, editSourceName: '共享名称', editSourceType: 'alias',
      editInspection: { normalizedName: editValue, status: 'available' }, editInspectionPending: false,
      selectTab: setTab, selectOwner, selectSource: setSource, openEditName: () => setDialog('edit'), openMerge: () => setDialog('merge'),
      openIllegalName: () => setDialog('replacement'), openOtherOwner: () => setDialog('owner'),
      confirmOwnership: () => { window.conflictOwnershipConfirmed = true }, applySelectedPending: () => {}, requestDiscard: () => {} },
    dialogs: {
      otherOwner: { open: dialog === 'owner', search, excludedIds: [], options: others,
        window: { total: others.length, getItem: index => others[index], findIndex: predicate => others.findIndex(predicate), onVisibleRange: () => {}, retry: () => {}, error: null, loading: false },
        loading: false, error: null, choosingId: null, retry: () => {}, selected: otherSelected, changeSearch: setSearch,
        choose: item => { setOtherSelected(item); selectOwner({ actressId: item.id, revision: 1, mainName: item.main_name }); close() }, close },
      editName: { open: dialog === 'edit', value: editValue, change: setEditValue, submit: close, close, canSubmit: true },
      merge: { open: dialog === 'merge', actors: conflictFixtureActors, submit: close, close },
      replacement: { kind: dialog === 'replacement' ? 'illegal' : null, claimants: [claimant], mainNames: { 2: replacementName }, status: 'invalid',
        errors: { 2: '此名称已被其他演员使用，请更换主名。' }, change: (_id, value) => setReplacementName(value), submit: close, close, canSubmit: false },
      discard: { candidate: null, busy: false, confirm: close, cancel: close }
    }
  }
  return <main data-actress-conflict-host style={{ padding: 24, height: '100%', minHeight: 0, display: 'grid', color: 'var(--text-primary)' }}>
    <PendingActressConflictPane vm={vm} />
  </main>
}
const { default: ClassificationPicker } = await import('../../apps/desktop/src/renderer/src/components/ClassificationPicker')
const { FilterPanelAnchor } = await import('../../apps/desktop/src/renderer/src/components/FilterPanelContent')
const { default: VideoResourceFilterFieldset } = await import('../../apps/desktop/src/renderer/src/components/VideoResourceFilterFieldset')
const { default: TagFilter } = await import('../../apps/desktop/src/renderer/src/components/TagFilter')
function Selection() {
  const [count, setCount] = useState(3)
  const [sort, setSort] = useState({ value: 'name', dir: 'asc' })
  const [filterOpen, setFilterOpen] = useState(false)
  const [libraryMode, setLibraryMode] = useState(false)
  const emptyLibraryFilter = { status: 'all', pendingScrape: 'all', year: 'all', codePrefix: '', sortBy: 'code', sortDir: 'asc', tagIds: [], resourceKinds: [] }
  const [libraryFilter, setLibraryFilter] = useState(emptyLibraryFilter)
  const filterRef = useRef(null)
  const [actressFilter, setActressFilter] = useState({ status: 'all', avatar: 'all' })
  const [resourceKinds, setResourceKinds] = useState([])
  const [tags, setTags] = useState([])
  return <div style={{ padding: 24, '--toolbar-control-h': '36px' }}><SelectionToolbar countLabel={`已选择 ${count} 项`}
    onClear={() => setCount(0)} actions={[{ key: 'edit', label: '批量编辑', onClick: () => setCount(2) }, { key: 'delete', label: '删除', disabled: true, onClick: () => {} }]} />
    <SortSwitch label="测试排序" compact quickValues={['name', 'date']} options={[{ value: 'name', label: '名称' }, { value: 'date', label: '日期' }, { value: 'external_rating', label: '外部评分' }]}
      value={sort.value} dir={sort.dir} onChange={(value, dir) => setSort({ value, dir })} />
    <FilterPanelAnchor>
      <FilterTrigger ref={filterRef} open={filterOpen} active={false} onClick={() => setFilterOpen(value => !value)} />
      {libraryMode ? <LibraryFilterPopover open={filterOpen} anchorRef={filterRef} state={libraryFilter} years={[2026, 2025]}
        onChange={patch => setLibraryFilter(value => ({ ...value, ...patch }))}
        onReset={() => setLibraryFilter(emptyLibraryFilter)} onClose={() => setFilterOpen(false)} /> : <ActressFilterPopover open={filterOpen} anchorRef={filterRef} state={actressFilter}
        onChange={patch => setActressFilter(value => ({ ...value, ...patch }))}
        onReset={() => setActressFilter({ status: 'all', avatar: 'all' })} onClose={() => setFilterOpen(false)} />}
    </FilterPanelAnchor>
    <button onClick={() => setLibraryMode(true)}>切换媒体库筛选测试</button>
    <Button className={actressPageStyles.conflictEntry}>待确认测试</Button>
    <VideoResourceFilterFieldset value={resourceKinds} onChange={setResourceKinds} />
    <TagFilter variant="popover" showInlineChips={false} selected={tags} onChange={setTags} />
    </div>
}
const { default: ActressFaceScanModal } = await import('../../apps/desktop/src/renderer/src/components/ActressFaceScanModal')
const { default: AssetCryptoOverlay } = await import('../../apps/desktop/src/renderer/src/components/AssetCryptoOverlay')
const { default: ImageImportModal } = await import('../../apps/desktop/src/renderer/src/components/ImageImportModal')
const { default: ImageImportField } = await import('../../apps/desktop/src/renderer/src/components/ImageImportField')
const { default: ActressAvatarEditor } = await import('../../apps/desktop/src/renderer/src/components/ActressAvatarEditor')
const { default: ScrapeFieldsModal } = await import('../../apps/desktop/src/renderer/src/components/ScrapeFieldsModal')
const { default: BatchTaskControls } = await import('../../apps/desktop/src/renderer/src/components/settings/BatchTaskControls')
const { default: BatchSettingsPanel } = await import('../../apps/desktop/src/renderer/src/components/settings/BatchSettingsPanel')
const { SettingsEmptyPanel } = await import('../../apps/desktop/src/renderer/src/components/settings/SettingsPrimitives')
const { default: PluginsSettingsPanel } = await import('../../apps/desktop/src/renderer/src/components/settings/PluginsSettingsPanel')
const { default: PluginSourceBadge } = await import('../../apps/desktop/src/renderer/src/components/PluginSourceBadge')
const { PluginConfigModal } = await import('../../apps/desktop/src/renderer/src/components/settings/PluginConfigModals')
const { default: PluginDevConfigRail } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConfigRail')
const { default: PluginDevMediaTargetPicker } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevMediaTargetPicker')
const { default: PluginDevConversation } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConversation')
const { default: PluginDevAgentRail } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevAgentRail')
const { default: CodeEditor } = await import('../../apps/desktop/src/renderer/src/components/CodeEditor')
const { default: PluginDevCodeModal } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevCodeModal')
const pluginDevPanelStyles = (await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevPanel.module.css')).default
const mediaLibrarySettingsStyles = (await import('../../apps/desktop/src/renderer/src/pages/MediaLibrarySettingsPage.module.css')).default
const pluginsSettingsStyles = (await import('../../apps/desktop/src/renderer/src/components/settings/PluginsSettingsPanel.module.css')).default
const batchSettingsStyles = (await import('../../apps/desktop/src/renderer/src/components/settings/BatchSettingsPanel.module.css')).default
const { default: Modal } = await import('../../apps/desktop/src/renderer/src/components/Modal')
const batchControlStyles = (await import('../../apps/desktop/src/renderer/src/components/settings/BatchTaskControls.module.css')).default
const { default: SettingsOverviewPanel, BatchOverviewStatus, ScrapeCoverageBlock, SettingsStatusCard } = await import('../../apps/desktop/src/renderer/src/components/settings/SettingsOverviewPanel')
const { default: SettingsPanel, SettingsPanelTitle } = await import('../../apps/desktop/src/renderer/src/components/settings/SettingsPanel')
const { default: AppUpdatePanel } = await import('../../apps/desktop/src/renderer/src/components/settings/AppUpdatePanel')
const settingsPageStyles = (await import('../../apps/desktop/src/renderer/src/pages/SettingsPage.module.css')).default
const { default: SettingsWorkspaceShell } = await import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell')
const settingsWorkspaceStyles = (await import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell.module.css')).default
const { SETTINGS_GROUPS } = await import('../../apps/desktop/src/renderer/src/settings/settingsRoutes')
const { default: PluginDevConnectionModal } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevConnectionModal')
const { default: ActressDeleteModal } = await import('../../apps/desktop/src/renderer/src/components/ActressDeleteModal')
const settingsOverviewStyles = (await import('../../apps/desktop/src/renderer/src/components/settings/SettingsOverviewPanel.module.css')).default
const { default: IconButton } = await import('../../apps/desktop/src/renderer/src/components/IconButton')
const { WorkbenchShell, WorkbenchToolbar, WorkbenchMain, WorkbenchStatusPill } = await import('../../apps/desktop/src/renderer/src/components/workbench/Workbench')
function ImageImport() {
  return <ImageImportModal title="导入测试图片" itemLabel="图片" emptyText="添加图片开始导入" urlHint="模拟链接预览，不访问网络"
    onCancel={() => {}} onChanged={() => {}} onImportFilePath={async () => {}} onImportUrl={async () => {}} />
}
function FaceScan() {
  const [status, setStatus] = useState('running')
  return <ActressFaceScanModal progress={{ status, total: 100, current: 35, reused: 10, hasFace: 20, withoutFace: 4, failed: 1, currentName: '演员进度测试' }}
    summary={null} onCancel={() => setStatus('cancelling')} onDone={() => {}} />
}
const { default: MediaTileActionButton } = await import('../../apps/desktop/src/renderer/src/components/MediaTileActionButton')
const { default: VirtualPosterGrid } = await import('../../apps/desktop/src/renderer/src/components/VirtualPosterGrid')
const { default: VirtualActressGrid } = await import('../../apps/desktop/src/renderer/src/components/VirtualActressGrid')
const actresses = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, main_name: `演员-${index + 1}`, gender: 'female', avatar_path: null, video_count: 1, scraped_status: 1 }))
function ActressGrid() {
  const [selected, setSelected] = useState(new Set())
  return <VirtualActressGrid actresses={actresses} selectedIds={selected} selectionMode
    hasMore={false} loadingMore={false} loadMoreFailed={false} onLoadMore={() => {}} onRetryLoadMore={() => {}}
    onOpen={() => {}} onDelete={() => {}} scrollMemoryKey="fixture-actresses"
    onToggleSelect={actress => setSelected(new Set([actress.id]))} />
}
const { default: PosterCard } = await import('../../apps/desktop/src/renderer/src/components/PosterCard')
const { default: ActressCardTile } = await import('../../apps/desktop/src/renderer/src/components/ActressCardTile')
const { default: PlaylistCard } = await import('../../apps/desktop/src/renderer/src/components/PlaylistCard')
const { default: PlaylistPickerRow } = await import('../../apps/desktop/src/renderer/src/components/PlaylistPickerRow')
const { default: PlaylistVideoPicker } = await import('../../apps/desktop/src/renderer/src/components/PlaylistVideoPicker')
const { default: PlaylistDetailPage } = await import('../../apps/desktop/src/renderer/src/pages/PlaylistDetailPage')
const { PlaylistImportProvider } = await import('../../apps/desktop/src/renderer/src/components/playlistImport/PlaylistImportContext')
const { default: DetailSectionTitle } = await import('../../apps/desktop/src/renderer/src/components/DetailSectionTitle')
const { default: VideoTagPanel } = await import('../../apps/desktop/src/renderer/src/components/VideoTagPanel')
const { default: VideoDetailRatings } = await import('../../apps/desktop/src/renderer/src/components/VideoDetailRatings')
const { default: RelatedLinksList } = await import('../../apps/desktop/src/renderer/src/components/RelatedLinksList')
const { default: ClassificationProfile } = await import('../../apps/desktop/src/renderer/src/components/ClassificationProfile')
const { default: ListPage } = await import('../../apps/desktop/src/renderer/src/components/ListPage')
const { default: ClassificationDetailSurface, ClassificationVideoHeading } = await import('../../apps/desktop/src/renderer/src/components/ClassificationDetailSurface')
const { default: FacetCard } = await import('../../apps/desktop/src/renderer/src/components/FacetCard')
const { default: AliasTagEditor } = await import('../../apps/desktop/src/renderer/src/components/AliasTagEditor')
const { default: PluginDevFieldTags, allFieldIdsForKind } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevFieldTags')
const { AppFormField, EditForm, EditFormCheckRow, EditFormField, EditFormFields, EditFormLabelNote, EditFormSection } = await import('../../apps/desktop/src/renderer/src/components/FormPrimitives')
const actressEditStyles = (await import('../../apps/desktop/src/renderer/src/components/EditActressModal.module.css')).default
const { DetailSection, DetailSectionHead, DetailSectionCount, DetailSectionActions } = await import('../../apps/desktop/src/renderer/src/components/DetailSection')
const { default: DetailPane, DetailPaneOverlay } = await import('../../apps/desktop/src/renderer/src/components/DetailPane')
const { default: DetailScrollBody } = await import('../../apps/desktop/src/renderer/src/components/DetailScrollBody')
const { default: EmptyState } = await import('../../apps/desktop/src/renderer/src/components/EmptyState')
const { default: SharedChromeFixture } = await import('./shared-chrome-fixture')
const layoutStyles = (await import('../../apps/desktop/src/renderer/src/components/Layout.module.css')).default
// Isolated child fixtures consume the shell's real semantic-variable contract,
// not its flex/height/overflow geometry. The actual Layout has its own fixture.
window.applyFixtureBackground = host => {
  const shell = document.createElement('div')
  shell.className = layoutStyles.root
  shell.style.display = 'none'
  document.body.append(shell)
  const css = getComputedStyle(shell)
  const before = new Map(Array.from(css).filter(name => name.startsWith('--')).map(name => [name, css.getPropertyValue(name)]))
  shell.dataset.background = 'true'
  const changed = Array.from(getComputedStyle(shell)).filter(name => name.startsWith('--') && before.get(name) !== css.getPropertyValue(name))
  if (changed.length < 10) throw new Error('Shell background contract was not applied')
  for (const name of changed) host.style.setProperty(name, css.getPropertyValue(name))
  shell.remove()
}
const { default: ActressProfileMeta } = await import('../../apps/desktop/src/renderer/src/components/ActressProfileMeta')
const { default: ActressAvatar } = await import('../../apps/desktop/src/renderer/src/components/ActressAvatar')
const { default: ActressName } = await import('../../apps/desktop/src/renderer/src/components/ActressName')
const { default: DetailActionBar } = await import('../../apps/desktop/src/renderer/src/components/DetailActionBar')
const { default: DetailInfoChip } = await import('../../apps/desktop/src/renderer/src/components/DetailInfoChip')
const { VideoDetailSecondaryMeta } = await import('../../apps/desktop/src/renderer/src/components/VideoDetailMeta')
const { VideoDetailPrimaryMeta, VideoMaintenanceInfo } = await import('../../apps/desktop/src/renderer/src/components/VideoDetailMeta')
const { default: MetaLink } = await import('../../apps/desktop/src/renderer/src/components/MetaLink')
const { default: ScrapeStatusBadge, PendingScrapeBadge } = await import('../../apps/desktop/src/renderer/src/components/ScrapeStatusBadge')
const actressDetailStyles = (await import('../../apps/desktop/src/renderer/src/pages/ActressDetailPage.module.css')).default
const detailTitleStyles = (await import('../../apps/desktop/src/renderer/src/components/DetailTitle.module.css')).default
const detailPageStyles = (await import('../../apps/desktop/src/renderer/src/pages/DetailPage.module.css')).default
const { default: GalleryImageTile } = await import('../../apps/desktop/src/renderer/src/components/GalleryImageTile')
const videoGalleryStyles = (await import('../../apps/desktop/src/renderer/src/components/VideoSampleGallery.module.css')).default
const actressGalleryStyles = (await import('../../apps/desktop/src/renderer/src/components/ActressGalleryPanel.module.css')).default
function DetailTitles() {
  return <main style={{ padding: 24, maxWidth: 620 }}>
    <DetailSection>
      <DetailSectionHead>
        <DetailSectionTitle>演员标题</DetailSectionTitle>
        <DetailSectionCount>3 位</DetailSectionCount>
      </DetailSectionHead>
    </DetailSection>
    <DetailSection>
      <DetailSectionHead>
        <DetailSectionTitle grow>资源标题</DetailSectionTitle>
        <DetailSectionActions><button type="button">添加资源</button></DetailSectionActions>
      </DetailSectionHead>
    </DetailSection>
  </main>
}
function DetailSectionsFixture() {
  return <main data-detail-sections-host style={{ padding: 24 }}>
    <DetailSection>
      <DetailSectionHead>
        <DetailSectionTitle>演员</DetailSectionTitle>
        <DetailSectionCount>2 位</DetailSectionCount>
      </DetailSectionHead>
      <div className={detailPageStyles.actressRowAvatars}>
        {['示例演员', '另一位演员'].map(name => <button key={name} type="button" className={detailPageStyles.actressMini}>
          <ActressAvatar src={null} name={name} gender="female" className={detailPageStyles.actressMiniAvatar} />
          <ActressName name={name} gender="female" className={detailPageStyles.actressMiniName} />
        </button>)}
      </div>
    </DetailSection>
    <DetailSection>
      <DetailSectionHead><DetailSectionTitle>剧情简介</DetailSectionTitle></DetailSectionHead>
      <div className={detailPageStyles.summaryText}>这是一段可选择复制的影片剧情简介。第二行用于检查文字换行与行距。</div>
    </DetailSection>
  </main>
}
function VideoTagsFixture() {
  return <main data-video-tags-host style={{ padding: 24, maxWidth: 740 }}>
    <VideoTagPanel videoId={1} tags={[{ id: 1, name: '刮削标签', origin: 'scraped' }, { id: 2, name: '自定义标签', origin: 'manual' }]}
      expectedVersions={{ V: { generation: 1, revision: 1 } }} onFilterTag={() => {}} onChanged={() => {}} />
  </main>
}
const exampleLinks = [{ position: 0, label: '官网资料', url: 'https://example.com/profile' }, { position: 1, label: '补充链接', url: 'https://example.com/extra' }]
function VideoInfoFixture() {
  const [rating, setRating] = useState(3)
  const [external, setExternal] = useState(true)
  return <main data-video-info-host style={{ padding: 24, maxWidth: 740 }}>
    <VideoDetailRatings video={{ rating, external_stats: external ? [{ id: 1, source: '示例来源', rating_average: 4.6, rating_count: 128 }] : [] }} onRatingChange={setRating} />
    <div style={{ marginTop: 20 }}><RelatedLinksList links={exampleLinks} selectable /></div>
    <div style={{ marginTop: 20 }}><RelatedLinksList links={[{ position: 0, label: '实体资料', url: 'https://example.com/entity' }]} /></div>
    <button type="button" onClick={() => setExternal(false)}>隐藏外部评分</button>
  </main>
}
function RelatedLinksEditorFixture() {
  const [links, setLinks] = useState([
    { label: '官网资料', url: 'https://example.com/profile' },
    { label: '补充链接', url: 'https://example.com/extra' }
  ])
  return <main data-related-links-editor-host style={{ padding: 24, maxWidth: 740 }}>
    <RelatedLinksEditor links={links} onChange={setLinks} />
  </main>
}
const profileFixtureImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#3678aa"/><circle cx="200" cy="120" r="80" fill="#d2a976"/></svg>')
function ClassificationProfileFixture({ kind }) {
  const profile = kind === 'Director'
    ? { title: '导演资料', kicker: '导演', name: '示例导演', meta: <span>本地作品：2018 - 2025</span>, aliases: ['另一名称'], summary: null }
    : kind === 'Series'
      ? { title: '系列资料', kicker: '系列', name: '示例系列', meta: <><span>连载中</span><span>所属：示例机构</span><span>本地发行：2020 - 2025</span></>, aliases: ['系列别名'], summary: '一段可复制的系列简介，用来验证窄窗口时的换行。' }
      : { title: '机构资料', kicker: '制作机构', name: '示例制作机构', meta: <><span>运营中</span><span>日本</span><span>本地发行：2019 - 2025</span></>, aliases: ['机构别名'], summary: '一段可复制的机构简介，用来验证窄窗口时的换行。' }
  return <main data-classification-profile-host style={{ padding: 24, maxWidth: 740 }}>
    <ClassificationProfile kind={kind.toLowerCase()} label={profile.title} kicker={profile.kicker}
      name={profile.name} imageUrl={profileFixtureImage} placeholder={<span>◫</span>}
      meta={profile.meta} aliases={profile.aliases} summary={profile.summary} links={exampleLinks} />
  </main>
}
function ClassificationDetailLayoutFixture() {
  return <main data-classification-detail-layout-host style={{ display: 'flex', height: '100%' }}>
    <ListPage>
      <ClassificationDetailSurface>
        <div data-classification-summary-card style={{ minHeight: 120, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--surface-panel)', padding: 16 }}>分类资料卡</div>
        <ClassificationVideoHeading />
        <div data-classification-video-row style={{ minHeight: 80, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--surface-panel)', padding: 16 }}>关联影片列表</div>
        <div style={{ minHeight: 800 }}>长列表占位</div>
      </ClassificationDetailSurface>
    </ListPage>
  </main>
}
function ClassificationCardsFixture() {
  return <main data-classification-cards-host style={{ padding: 24, maxWidth: 900, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
    <FacetCard kind="organization" name="示例机构" imageUrl={profileFixtureImage} placeholder={<span>◇</span>}
      videoCount={28} onOpen={() => { window.lastFacetCard = 'organization' }} />
    <FacetCard kind="series" name="示例系列" imageUrl={profileFixtureImage} placeholder={<span>◇</span>}
      subtitle="所属：示例机构" videoCount={15} onOpen={() => { window.lastFacetCard = 'series' }} />
    <FacetCard kind="director" name="示例导演" imageUrl={null} placeholder={<span>◇</span>}
      videoCount={7} onOpen={() => { window.lastFacetCard = 'director' }} />
  </main>
}
function AliasTagEditorFixture() {
  const [aliases, setAliases] = useState(['示例别名', '很长但仍应保持紧凑的别名'])
  return <main data-alias-editor-host style={{ padding: 24, maxWidth: 620 }}>
    <AliasTagEditor id="alias-fixture" aliases={aliases} onChange={setAliases}
      onPromoteToMain={alias => { window.lastPromotedAlias = alias }} />
    <div style={{ marginTop: 16 }}><AliasTagEditor aliases={['禁用别名']} onChange={() => {}} disabled /></div>
  </main>
}
function PluginDevFieldTagsFixture() {
  const [fields, setFields] = useState(() => allFieldIdsForKind('video').slice(0, 2))
  return <main data-plugin-field-tags-host style={{ padding: 24, maxWidth: 620 }}>
    <PluginDevFieldTags kind="video" supportedFieldIds={fields} busy={false} onChange={setFields} />
    <div style={{ marginTop: 16 }}><PluginDevFieldTags kind="video" supportedFieldIds={[]} busy onChange={() => {}} /></div>
  </main>
}
function PluginDevTargetFixture({ kind }) {
  const [selected, setSelected] = useState([])
  return <main data-plugin-dev-target-host style={{ height: '100%', padding: 24 }}>
    <PluginDevMediaTargetPicker kind={kind} selectedValues={selected}
      onAdd={value => setSelected(previous => [...previous, value])} onClose={() => {}} />
  </main>
}
function PluginDevConversationFixture({ active = false }) {
  const [feedback, setFeedback] = useState('')
  const items = active ? [
    { id: 'user-1', type: 'user', text: '请检查这个站点的搜索与详情页面，并建立影片插件。' },
    { id: 'agent-1', type: 'agent', text: '已找到搜索入口。接下来将确认精确匹配的详情链接，并编写插件。' },
    { id: 'reasoning-1', type: 'reasoning', step: 2, turn: 1, text: '页面事实已经足够，准备固化搜索逻辑。', charCount: 19, truncated: false },
    { id: 'tool-1', type: 'tool', step: 3, tool: 'browser', summary: '已打开搜索页', detail: 'URL: https://example.test/search?q=ABC-123', ok: true },
    { id: 'tool-2', type: 'tool', step: 4, tool: 'plugin_dry_run', summary: '需要补充一个字段', detail: '缺少影片标题', ok: false }
  ] : []
  return <main data-plugin-dev-conversation-host style={{ display: 'flex', height: 620, maxWidth: 720, padding: 24 }}>
    <PluginDevConversation visible items={items} activeTool={active ? 'browser' : null} agentPhase="working" agentStep={active ? 5 : 0}
      contextStats={null} running={active} feedbackText={feedback} agentStatus={active ? 'running' : null}
      busy={active} canSend={!active} canCancelAgent={active} canClearHistory={active} clearHistoryBusy={false}
      canExportWorkLog={active} exportWorkLogBusy={false} waitingUserReason={null} artifactReady={false}
      pendingApproval={null} pendingUserRequest={null} onFeedbackChange={setFeedback}
      onSend={() => { window.lastPluginDevConversationAction = 'send' }}
      onCancelAgent={() => { window.lastPluginDevConversationAction = 'cancel' }}
      onClearHistory={() => {}} onContinueBrowserInteraction={() => {}} onFieldMapping={() => {}}
      onApprovalDecision={() => {}} onExportWorkLog={() => {}} />
  </main>
}
function PluginDevAgentRailFixture() {
  const [tab, setTab] = useState('conversation')
  const [feedback, setFeedback] = useState('')
  const dryRun = { ok: true, result: null, cases: [
    { target: 'ABC-123', ok: true, result: { code: 'ABC-123', title: '示例影片标题', sourceUrl: 'https://example.test/ABC-123' } },
    { target: 'XYZ-456', ok: false, result: null, error: '试运行未找到精确匹配的详情页。' }
  ] }
  return <main data-plugin-dev-agent-rail-host style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', width: 'min(100%, 520px)', height: 620, padding: 24, boxSizing: 'border-box' }}>
    <PluginDevAgentRail kind="video" tab={tab} conversationCount={2} resultCount={2} agentStatus="waiting_user"
      agentPhase="waiting_user" agentStep={5} contextStats={null} activeTool={null}
      conversationItems={[{ id: 'user-1', type: 'user', text: '请检查影片详情。' }, { id: 'agent-1', type: 'agent', text: '已完成一轮试运行，请查看结果。' }]}
      dryRun={dryRun} execution={null} acceptance={null} resultStale={false} installState="dirty"
      waitingUserReason={null} artifactReady={false} pendingApproval={null} pendingUserRequest={null}
      feedbackText={feedback} busy={false} canSend canCancelAgent={false} canClearHistory clearHistoryBusy={false}
      canExportWorkLog exportWorkLogBusy={false} onTabChange={setTab} onFeedbackChange={setFeedback}
      onSend={() => {}} onCancelAgent={() => {}} onClearHistory={() => {}}
      onContinueBrowserInteraction={() => {}} onFieldMapping={() => {}} onApprovalDecision={() => {}} onExportWorkLog={() => {}} />
  </main>
}
const fixturePluginCode = [
  '// 代码高亮与滚动夹具',
  'export async function scrape(ctx) {',
  '  const title = "示例影片 ABC-123";',
  '  const count = 42;',
  '  return { code: ctx.code, title, count };',
  '}'
].join('\n')
function CodeEditorFixture() {
  const [value, setValue] = useState(fixturePluginCode)
  return <main data-code-editor-host style={{ padding: 24, maxWidth: 740 }}>
    <div style={{ minHeight: 280 }}><CodeEditor value={value} onChange={setValue} aria-label="插件代码编辑器" /></div>
  </main>
}
function PluginDevCodeModalFixture() {
  const [open, setOpen] = useState(true)
  return <main data-plugin-code-modal-host>{open && <PluginDevCodeModal kind="video" pluginName="Fixture Plugin"
    code={Array.from({ length: 14 }, () => fixturePluginCode).join('\n\n')} onClose={() => setOpen(false)} />}</main>
}
function PluginDevKindToggleFixture() {
  const [kind, setKind] = useState('video')
  return <main data-plugin-dev-kind-toggle-host style={{ padding: 24, maxWidth: 640 }}>
    <div className={`${pluginDevPanelStyles.kindToggle} ${pluginDevPanelStyles.toolbarKindToggle}`}
      role="group" aria-label="插件类型">
      {['video', 'actress'].map((value) => <button key={value} type="button"
        className={`${pluginDevPanelStyles.kindButton}${kind === value ? ` ${pluginDevPanelStyles.kindButtonActive}` : ''}`}
        onClick={() => setKind(value)}>{value === 'video' ? '影片' : '演员'}</button>)}
    </div>
  </main>
}
function PluginDevWorkspaceFixture({ settings = false }) {
  const [kind, setKind] = useState('video')
  const [status, setStatus] = useState('waiting')
  return <main data-plugin-dev-workspace-host
    className={settings ? `${settingsWorkspaceStyles.root} ${settingsWorkspaceStyles.pluginDevPage}` : undefined}
    style={{ height: 600, padding: 24, boxSizing: 'border-box', display: 'flex', containerType: 'inline-size', containerName: 'settings-workspace' }}>
    <WorkbenchShell className={`${pluginDevPanelStyles.shell}${settings ? ` ${pluginDevPanelStyles.shellSettings}` : ''}`} style={{ width: '100%', minHeight: 0 }}>
      <nav className={pluginDevPanelStyles.breadcrumb} aria-label="当前位置">
        <button className={pluginDevPanelStyles.backLink} type="button">设置</button><span>/</span>
        <button className={pluginDevPanelStyles.backLink} type="button">刮削插件</button><span>/</span><strong>开发助手</strong>
      </nav>
      <WorkbenchToolbar className={pluginDevPanelStyles.toolbar}>
        <div className={pluginDevPanelStyles.toolbarStart}>
          <div className={`${pluginDevPanelStyles.kindToggle} ${pluginDevPanelStyles.toolbarKindToggle}`} role="group" aria-label="插件类型">
            {['video', 'actress'].map(value => <button key={value} type="button"
              className={`${pluginDevPanelStyles.kindButton}${kind === value ? ` ${pluginDevPanelStyles.kindButtonActive}` : ''}`}
              onClick={() => setKind(value)}>{value === 'video' ? '影片' : '演员'}</button>)}
          </div>
          <WorkbenchStatusPill className={pluginDevPanelStyles.statusPill} data-status={status}>
            {status === 'waiting' ? '等待确认' : '运行中'}
          </WorkbenchStatusPill>
        </div>
        <div className={pluginDevPanelStyles.toolbarActions}>
          <PluginSourceBadge source="user">示例模型</PluginSourceBadge>
          <span className={pluginDevPanelStyles.codeActionSlot}><IconButton className={pluginDevPanelStyles.toolbarIconButton}
            icon={<Settings size={16} />} label="查看代码" onClick={() => setStatus('running')} /></span>
          <IconButton className={pluginDevPanelStyles.toolbarIconButton} icon={<Settings size={16} />} label="连接设置" />
        </div>
      </WorkbenchToolbar>
      <WorkbenchMain className={`${pluginDevPanelStyles.main} ${pluginDevPanelStyles.mainAgentFocus}${settings ? ` ${pluginDevPanelStyles.mainSettings}` : ''}`}>
        <aside style={{ minHeight: 260, background: 'var(--surface-control)', border: '1px solid var(--border-subtle)' }}>配置栏</aside>
        <section style={{ minHeight: 260, background: 'var(--surface-control)', border: '1px solid var(--border-subtle)' }}>Agent 栏</section>
      </WorkbenchMain>
    </WorkbenchShell>
  </main>
}
function AppFormFieldFixture() {
  const [name, setName] = useState('')
  return <main data-app-form-field-host className={settingsWorkspaceStyles.root} style={{ padding: 24, maxWidth: 480 }}>
    <AppFormField label="媒体库名称" hint="用于展示在媒体库列表中。">
      <TextInput density="workspace" value={name} onChange={event => setName(event.target.value)} aria-label="媒体库名称" />
    </AppFormField>
  </main>
}
function PluginDevConfigRailFixture({ debug = false }) {
  const [siteUrl, setSiteUrl] = useState(debug ? 'https://example.test' : '')
  const [testTarget, setTestTarget] = useState(debug ? '' : 'ABC-123')
  const [fields, setFields] = useState(['title', 'cover'])
  return <main data-plugin-dev-rail-host style={{ display: 'flex', height: 640, padding: 24 }}>
    <div className={pluginDevPanelStyles.shell} style={{ display: 'flex', width: 300, minHeight: 0 }}>
      <PluginDevConfigRail kind="video" siteName="Fixture Plugin" siteUrl={siteUrl} testTarget={testTarget}
        description="采集详情资料" version="1.0.0" author="Fixture" supportedFields={fields}
        fieldLabel={(_kind, field) => field} loadedInstalledName={debug ? 'Fixture Plugin' : null}
        forkedFromBuiltIn={null} selectedPluginName={debug ? 'Fixture Plugin' : ''}
        selectablePlugins={[{ name: 'Fixture Plugin', source: 'user' }]} pluginsLoading={false}
        busy={false} canUseAgent hasPackage={debug} canResumeAgent={false} agentCompleted={false}
        agentReady={false} feedbackPending={false}
        agentDisabledReason={debug ? '需要填写测试目标后继续。' : '下一步请先填写网站主页。'}
        agentPrimaryDisabledReason={null} activeLlmReady agentBusy={false} installBusy={false} canInstall={false}
        onSelectPlugin={() => {}} onStartAgent={() => { window.lastPluginDevRailAction = 'start' }}
        onInstall={() => { window.lastPluginDevRailAction = 'install' }} onSiteNameChange={() => {}}
        onSiteUrlChange={setSiteUrl} onTestTargetChange={setTestTarget} onDescriptionChange={() => {}}
        onVersionChange={() => {}} onAuthorChange={() => {}} onSupportedFieldsChange={setFields} />
    </div>
  </main>
}
function EntityEditFormFixture() {
  const [name, setName] = useState('示例机构')
  const [owner, setOwner] = useState('示例厂商')
  return <main data-entity-edit-form-host style={{ padding: 24, maxWidth: 700 }}>
    <EditForm>
      <EditFormSection title="名称与简介">
        <EditFormFields>
          <EditFormField label="主名" htmlFor="entity-fixture-name" span={2}>
            <TextInput id="entity-fixture-name" density="workspace" value={name} onChange={e => setName(e.target.value)} />
          </EditFormField>
          <EditFormField label="别名" htmlFor="entity-fixture-alias" span={2}
            labelExtra={<EditFormLabelNote>点击设为主名</EditFormLabelNote>}>
            <TextInput id="entity-fixture-alias" density="workspace" defaultValue="示例别名" />
          </EditFormField>
          <EditFormCheckRow>
            <Checkbox defaultChecked />将旧主名保留为别名
          </EditFormCheckRow>
          <EditFormField label="国家或地区" htmlFor="entity-fixture-country">
            <TextInput id="entity-fixture-country" density="workspace" defaultValue="日本" />
          </EditFormField>
          <EditFormField label="身高" htmlFor="entity-fixture-height">
            <div className={actressEditStyles.inputSuffix} data-entity-edit-input-suffix>
              <TextInput id="entity-fixture-height" density="workspace" defaultValue="165" />
              <span className={actressEditStyles.inputUnit}>cm</span>
            </div>
          </EditFormField>
          <EditFormField label="三围" span={2}>
            <div className={actressEditStyles.inlineFieldRow} data-entity-edit-inline-row>
              {['胸围', '腰围', '臀围'].map((label, index) => <div key={label} className={actressEditStyles.inputSuffix}>
                <TextInput density="workspace" aria-label={label} defaultValue={String(80 + index * 5)} />
                <span className={actressEditStyles.inputUnit}>cm</span>
              </div>)}
            </div>
          </EditFormField>
        </EditFormFields>
      </EditFormSection>
      <EditFormSection title="补充信息">
        <EditFormFields>
          <EditFormField label="简介" htmlFor="entity-fixture-summary" span={2}>
            <TextArea id="entity-fixture-summary" density="workspace" rows={4} defaultValue="用于验证编辑弹窗中的字段布局。" />
          </EditFormField>
          <EditFormField label="所属机构" htmlFor="entity-fixture-owner" span={2}>
            <ClassificationPicker id="entity-fixture-owner" value={owner} options={[]} selectedId={null}
              listLabel="机构候选" onValueChange={setOwner} onSelect={() => {}} />
          </EditFormField>
        </EditFormFields>
      </EditFormSection>
    </EditForm>
  </main>
}
function EntityMediaSectionFixture() {
  return <main data-entity-media-host style={{ padding: 24, maxWidth: 700 }}>
    <EditForm>
      <EditFormSection title="封面" variant="media">
        <ImageImportField label="封面" hideLabel layout="inline" currentUrl={null}
          hint="从本地选择图片替换当前封面；保存后生效。" onSourcePathChange={() => {}} />
      </EditFormSection>
    </EditForm>
  </main>
}
const imageImportPreview = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#477a82"/><circle cx="150" cy="90" r="52" fill="#d7e7df"/></svg>')}`
function ImageImportFieldFixture() {
  return <main data-image-import-host style={{ padding: 24, maxWidth: 700, display: 'grid', gap: 24 }}>
    <section data-image-import-wide>
      <ImageImportField label="封面" hideLabel layout="inline" currentUrl={null}
        hint="从本地选择图片替换当前封面；保存后生效。" onSourcePathChange={path => { window.lastImageImportPath = path }}
        extraActions={<Button type="button" variant="ghost" size="sm">移除当前封面</Button>} />
    </section>
    <section data-image-import-square>
      <ImageImportField label="方形封面" hideLabel layout="inline" previewShape="square"
        currentUrl={imageImportPreview} onSourcePathChange={() => {}} />
    </section>
    <section data-image-import-stack>
      <ImageImportField label="纵向封面" layout="stack" currentUrl={imageImportPreview}
        onSourcePathChange={() => {}} />
    </section>
  </main>
}
const avatarFixtureImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"><rect width="640" height="960" fill="#496d78"/><circle cx="320" cy="380" r="170" fill="#e0c6aa"/><rect x="190" y="560" width="260" height="350" rx="110" fill="#243d4d"/></svg>')}`
const { default: ClassificationDeleteModal } = await import('../../apps/desktop/src/renderer/src/components/ClassificationDeleteModal')
const { default: OrganizationDeleteModal } = await import('../../apps/desktop/src/renderer/src/components/OrganizationDeleteModal')
const { default: ActressGalleryPanel } = await import('../../apps/desktop/src/renderer/src/components/ActressGalleryPanel')
const { ImagePreviewOverlayProvider } = await import('../../apps/desktop/src/renderer/src/components/ImagePreviewOverlayContext')

const { default: ImagePreviewLightbox } = await import('../../apps/desktop/src/renderer/src/components/ImagePreviewLightbox')
const previewItems = Array.from({ length: 22 }, (_, index) => ({
  id: index + 1,
  src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="${index % 2 ? '#305b6b' : '#506448'}"/><circle cx="240" cy="140" r="70" fill="#ddd"/><text x="240" y="260" text-anchor="middle" font-size="30" fill="#fff">Image ${index + 1}</text></svg>`)}`,
  localPath: `/fixture/preview-${index + 1}.svg`
}))

const { default: AppearanceSettingsPanel } = await import('../../apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPanel')
function AppearanceFixture({ variant }) {
  const [settings, setSettings] = useState({
    avatarFaceRatio: 0.62, avatarCenteringMode: 'head', avatarPreserveFullHead: true,
    videoDetailUseFirstSampleBackground: false, actressDetailUseFirstGalleryBackground: true,
    showVideoResourceTypeBadges: false, coverDisplayMode: 'portrait', closeToTray: false,
    privacyModeEnabled: false, privacyModeScopes: ['covers','actressDefaultAvatar','videoSamples','actressGallery','globalBackground','imagePreview','mediaEditors']
  })
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [batch, setBatch] = useState({ status: 'idle', source: null, total: 0, current: 0, success: 0, failed: 0, skipped: 0, currentName: null, cancelled: false, logs: [], totalLogCount: 0, shortenedLogCount: 0 })
  const [rejectSave, setRejectSave] = useState(false)
  window.fixtureAvatarAnalysisMode = variant === 'appearancePending' ? 'pending' : variant === 'appearanceError' ? 'error' : 'ready'
  if (variant === 'appearanceReady') localStorage.setItem('javdex.avatar-composition-preview-analysis.v1', JSON.stringify({
    imageWidth: 1254, imageHeight: 1254, candidate: { id: 'fixture-face', confidence: 0.98, prominence: 1,
      box: { x: 0.3, y: 0.2, width: 0.4, height: 0.5 }, leftEye: { x: 0.4, y: 0.4 }, rightEye: { x: 0.6, y: 0.4 },
      ovalTop: { x: 0.5, y: 0.24 }, chin: { x: 0.5, y: 0.68 }, leftCheek: { x: 0.32, y: 0.48 }, rightCheek: { x: 0.68, y: 0.48 },
      headBounds: { x: 0.25, y: 0.05, width: 0.5, height: 0.7 }, geometrySource: 'mesh' }
  }))
  window.rejectAppearanceSave = setRejectSave
  window.finishAppearanceBatch = () => setBatch(current => ({ ...current, status: 'done', current: 20, success: 18, failed: 2, cancelled: true }))
  const avatarBatchAdapter = {
    state: batch, countAllAvatars: async () => 20,
    startAllAvatars: async () => { setBatch({ ...batch, status: 'running', source: 'manual', total: 20, current: 9, currentName: '测试演员长名称', logs: [{ time: '2026-09-30', level: 'info', code: 'fixture', message: '正在构图' }] }); return 20 },
    cancel: () => setBatch(current => ({ ...current, status: 'cancelling' }))
  }
  return <AvatarAutoCropBatchStateProvider value={avatarBatchAdapter}><main data-appearance-host style={{ padding: 24, display: 'grid', gridAutoRows: 'max-content', alignContent: 'start', gap: 16, overflow: 'auto', height: '100%' }}>
    <DisplayModeProvider><AppearanceSettingsPanel settings={settings} theme={theme} scrapeBatchActive={false}
      onThemeChange={next => { setTheme(next); window.lastAppearanceTheme = next }}
      onPatchSettings={async patch => { window.lastAppearancePatch = patch; if (rejectSave) return false; setSettings(current => ({ ...current, ...patch })); return true }}
      onOpenAvatarBatchDetails={() => { window.openedAppearanceLogs = true }}
    /></DisplayModeProvider>
  </main></AvatarAutoCropBatchStateProvider>
}

function ImagePreviewFixture({ variant }) {
  const [index, setIndex] = useState(variant === 'imagePreviewWindow' ? 0 : 1)
  const [open, setOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const bounded = variant === 'imagePreviewWindow'
  const missing = variant === 'imagePreviewMissing'
  const items = bounded ? previewItems.slice(0, 3) : missing ? previewItems.slice(0, 3).map(item => ({ ...item, localPath: null })) : previewItems
  window.setPreviewLoading = setLoading
  return <ImagePreviewOverlayProvider>{open ? <ImagePreviewLightbox
    items={items} index={index} windowOffset={bounded ? 60 : 0} total={bounded ? 121 : items.length}
    loading={loading} navigationStatus={loading ? <span>正在读取下一页…</span> : undefined}
    posterPath={previewItems[1].localPath} onClose={() => setOpen(false)}
    onIndexChange={next => { window.lastPreviewIndex = next; if (next >= 0 && next < items.length) setIndex(next) }}
    labels={{ dialog: '图片预览验收', filmstrip: '预览缩略图', thumb: n => `图片 ${n + 1}`, posterMissing: '没有本地图片，无法设为背景' }}
    onPosterChange={async (path, assetId) => {
      window.lastPreviewPoster = { path, assetId }
      await new Promise(resolve => { window.releasePreviewPoster = resolve })
    }}
  /> : <p>预览已关闭</p>}</ImagePreviewOverlayProvider>
}

function DeleteConfirmationFixture({ kind }) {
  const isRole = kind === 'deleteRole' || kind === 'deleteRoleBlocked'
  const impact = isRole ? { id: 7, role: 'maker', roleVideoCount: 3, remainingRoles: kind === 'deleteRoleBlocked' ? [] : ['publisher'], canRemove: kind !== 'deleteRoleBlocked' }
    : kind === 'deleteOrganization' ? { id: 7, makerVideoCount: 2, publisherVideoCount: 4, directChildCount: 1, ownedSeriesCount: 3 }
    : { id: 7, videoCount: 3, ...(kind === 'deleteDirector' ? {} : { directChildCount: 2 }) }
  const loadImpact = async () => {
    if (kind === 'deleteImpactError') throw new Error('影响范围读取失败：/fixture/分类资料/请稍后重试。')
    if (kind === 'deleteImpactLoading' && !window.deleteImpactReleased) await new Promise(resolve => { window.releaseDeleteImpact = () => { window.deleteImpactReleased = true; resolve() } })
    return impact
  }
  const remove = async current => { window.lastDeleteImpact = current; throw new Error('删除失败：资料修订已变化，请重新检查影响范围。') }
  return kind === 'deleteOrganization' || isRole
    ? <OrganizationDeleteModal mode={isRole ? 'role' : 'organization'} role="maker" organizationName="测试机构" loadImpact={loadImpact} remove={remove} onCancel={() => {}} onCompleted={() => {}} />
    : <ClassificationDeleteModal entityLabel={kind === 'deleteDirector' ? '导演' : '系列'} entityName="测试分类资料" loadImpact={loadImpact} remove={remove} onCancel={() => {}} onDeleted={() => {}} />
}
function GalleryPagingFixture() {
  return <main style={{ padding: 24, maxWidth: 760, height: 500, overflow: 'auto' }}>
    <ImagePreviewOverlayProvider><ActressGalleryPanel actressId={1} revision={{ generation: 1, revision: 1 }} posterPath={null} onChanged={() => {}} /></ImagePreviewOverlayProvider>
  </main>
}

function ActressAvatarEditorFixture() {
  return <main data-avatar-editor-host style={{ padding: 24, maxWidth: 760 }}>
    <ActressAvatarEditor displayUrl={avatarFixtureImage} sourceUrl={avatarFixtureImage}
      savedCrop={null} actressId={1} onAvatarChange={() => {}} />
  </main>
}
function ScrapeFieldsModalFixture() {
  return <main data-scrape-fields-host>
    <ScrapeFieldsModal title="批量刮削配置" scrapers={['JavDB']} initialScraperName="JavDB"
      options={[{ id: 'title', label: '标题' }, { id: 'cover', label: '封面' }, { id: 'avatar', label: '头像' }, { id: 'aliases', label: '别名' }]}
      initialSelected={['title', 'cover', 'avatar']}
      scopeOptions={[{ id: 'all', label: '全部影片' }, { id: 'pending', label: '待处理影片' }]}
      scopeCountLabel="128 部"
      missingFieldOptions={[{ id: 'title', label: '标题' }, { id: 'cover', label: '封面' }, { id: 'avatar', label: '头像' }]}
      initialMissingFields={['title']}
      updateModeOptions={[{ id: 'fillEmpty', label: '仅补充空字段', description: '保留已有资料' }, { id: 'replace', label: '替换所选字段', description: '覆盖已有资料' }]}
      showUseAliasesToggle showAutoCropAvatarToggle initialAutoCropAvatar
      onCancel={() => {}} onConfirm={(...args) => { window.lastScrapeFieldsConfirm = args }} />
  </main>
}
function BatchTaskControlsFixture() {
  return <main data-batch-controls-host style={{ padding: 24, maxWidth: 740, container: 'settings-workspace / inline-size', display: 'grid', gap: 24 }}>
    <section data-batch-button><BatchTaskControls scopeLabel="影片" running paused={false} status="running"
      onPause={() => {}} onResume={() => {}} onDiscard={() => {}} /></section>
    <section data-batch-icon><BatchTaskControls scopeLabel="演员" running={false} paused status="paused" variant="icon"
      onPause={() => {}} onResume={() => {}} onDiscard={() => {}} /></section>
    <section data-batch-detail><IconButton className={`${batchControlStyles.iconButton} ${batchControlStyles.detailIconButton}`}
      icon={<span>□</span>} label="查看批量任务详情" onClick={() => {}} /></section>
  </main>
}
function BatchSettingsPanelFixture({ state }) {
  const logRef = useRef(null)
  const logs = state === 'empty' ? [] : [
    { time: '2026-09-29T08:00:00Z', code: 'ABC-123', message: '已更新资料', level: 'success' },
    { time: '2026-09-29T08:00:01Z', code: 'XYZ-456', message: '等待处理', level: 'info' }
  ]
  const batch = state === 'empty' ? null : { status: state === 'paused' ? 'paused' : 'running', current: 37, total: 100,
    success: 31, failed: 2, currentCode: 'XYZ-456', logs }
  return <Modal title="批量更新（影片）" size="xl" className={settingsPageStyles.batchDetailModal} bodyOverflow="hidden"
    hideActions onCancel={() => {}}>
    <BatchSettingsPanel scope="video" batch={batch} running={state === 'running'} paused={state === 'paused'}
      canResume={state !== 'paused'} resumeDisabledReason={state === 'paused' ? '状态范围无法识别，请终止后重新启动' : null}
      logRef={logRef} emptyLog="暂无任务日志" pendingGroupCount={3} onOpenPending={() => { window.lastBatchSettingsAction = 'pending' }}
      onPause={() => { window.lastBatchSettingsAction = 'pause' }} onResume={() => { window.lastBatchSettingsAction = 'resume' }}
      onDiscard={() => { window.lastBatchSettingsAction = 'discard' }} />
  </Modal>
}
function SettingsEmptyVariantsFixture() {
  return <main data-settings-empty-host className={settingsWorkspaceStyles.root}
    style={{ padding: 24, maxWidth: 760, display: 'grid', gap: 16, container: 'settings-workspace / inline-size' }}>
    <section data-settings-empty-plain><SettingsEmptyPanel>尚无资料</SettingsEmptyPanel></section>
    <section data-settings-empty-dashed><SettingsEmptyPanel variant="dashed">尚未添加来源目录</SettingsEmptyPanel></section>
    <section data-settings-empty-compact><SettingsEmptyPanel variant="compact">尚无扫描记录</SettingsEmptyPanel></section>
    <section data-settings-empty-source><SettingsEmptyPanel variant="dashed" className={mediaLibrarySettingsStyles.sourceEmpty}>暂无来源</SettingsEmptyPanel></section>
    <section data-settings-empty-plugin>
      <SettingsEmptyPanel variant="dashed" className={pluginsSettingsStyles.emptyState}
        descriptionClassName={pluginsSettingsStyles.emptyStateDescription}>
        <span>尚未安装插件</span>
        <div className={pluginsSettingsStyles.emptyStateActions}>
          <Button type="button" size="sm" onClick={() => { window.lastSettingsEmptyAction = 'import' }}>导入插件</Button>
        </div>
      </SettingsEmptyPanel>
    </section>
    <section data-settings-empty-batch style={{ display: 'flex', flexDirection: 'column', height: 200 }}>
      <SettingsEmptyPanel variant="compact" className={batchSettingsStyles.emptyPanel}>暂无任务日志</SettingsEmptyPanel>
    </section>
  </main>
}
function SettingsLoadingFixture() {
  return <main data-settings-loading-host className={settingsWorkspaceStyles.root} style={{ padding: 24, height: 360 }}>
    <EmptyState loading title={<span className={settingsPageStyles.loadingLabel}>加载设置…</span>} />
  </main>
}
const pluginSettingsFixtureCards = [
  { kind: 'video', name: 'Fixture Builtin', source: 'builtin', version: '1.0.0', description: '内置资料来源',
    supportedFields: ['title', 'cover', 'releaseDate'], delay: { minMs: 1000, maxMs: 2000 },
    removable: false, exportable: false, editable: true, debuggable: true },
  { kind: 'video', name: 'Fixture User', source: 'user', version: '2.1.0', description: '用户导入的插件，支持多个字段。',
    supportedFields: ['title', 'cover'], delay: { minMs: 500, maxMs: 1500 },
    removable: true, exportable: true, editable: true, debuggable: true },
  { kind: 'video', name: 'Fixture Composite', source: 'composite', version: '组合', description: '按字段组合来源',
    supportedFields: ['title', 'cover', 'releaseDate', 'rating'], fieldPluginMap: { title: 'Fixture Builtin', cover: 'Fixture User' },
    delay: { minMs: 0, maxMs: 0 }, removable: true, exportable: true, editable: true, debuggable: false }
]
function PluginsSettingsFixture({ empty = false }) {
  return <main data-plugins-settings-host className={settingsWorkspaceStyles.root}
    style={{ padding: 24, maxWidth: 760, container: 'settings-workspace / inline-size' }}>
    <PluginsSettingsPanel kind="video"
      videoUserPlugins={empty ? [] : [pluginSettingsFixtureCards[1]]}
      actressUserPlugins={[]} videoCompositePlugins={empty ? [] : [pluginSettingsFixtureCards[0], pluginSettingsFixtureCards[2]]}
      actressCompositePlugins={[]} defaultVideoPluginName="Fixture Builtin" defaultActressPluginName=""
      pluginBusy={null} onImport={() => { window.lastPluginsSettingsAction = 'import' }}
      onOpenDev={() => { window.lastPluginsSettingsAction = 'dev' }}
      onEdit={() => { window.lastPluginsSettingsAction = 'edit' }}
      onExport={() => { window.lastPluginsSettingsAction = 'export' }}
      onAiDebug={() => { window.lastPluginsSettingsAction = 'debug' }}
      onRequestDelete={() => { window.lastPluginsSettingsAction = 'delete' }}
      onSetDefault={() => { window.lastPluginsSettingsAction = 'default' }}
      onCreateComposite={() => { window.lastPluginsSettingsAction = 'composite' }} />
    {!empty && <div data-plugin-source-badges style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
      <PluginSourceBadge source="builtin">内置插件</PluginSourceBadge>
      <PluginSourceBadge source="user">用户插件</PluginSourceBadge>
      <PluginSourceBadge source="composite">组合插件</PluginSourceBadge>
      <PluginSourceBadge source="user">已配置模型</PluginSourceBadge>
    </div>}
  </main>
}
function PluginConfigFixture({ variant }) {
  const builtin = variant === 'builtin'
  const plugin = builtin
    ? { kind: 'video', name: 'MetaTube', source: 'builtin', version: '1.0.0', description: 'MetaTube service plugin',
      homepage: 'https://example.test/metatube', author: 'Fixture', supportedFields: ['title', 'cover', 'releaseDate'],
      delay: { minMs: 1000, maxMs: 2000 }, requiresConfiguration: true, configured: true }
    : { kind: 'video', name: 'Fixture User', source: 'user', version: '2.0.0', description: '自定义插件说明',
      homepage: 'https://example.test/plugin', author: 'Fixture', supportedFields: ['title', 'cover'],
      delay: { minMs: 500, maxMs: 1500 }, overridesBuiltIn: true, preLoginAvailable: true, preLogin: true }
  return <main data-plugin-config-host>
    <PluginConfigModal state={{ kind: 'video', plugin,
      ...(builtin ? { serviceConfig: { serverUrl: 'https://server.test/prefix', useScrapeProxy: false,
        keepFirstCandidate: false, hasToken: true, secretProtection: 'secure' } } : {}) }}
      onSave={() => { window.lastPluginConfigAction = 'save' }} onCancel={() => { window.lastPluginConfigAction = 'cancel' }}
      onTestService={async () => ({ app: 'metatube', version: '1.4.0', dbVersion: '42', movieProviderCount: 3 })} />
  </main>
}
function ScrapeCoverageFixture() {
  return <main data-scrape-coverage-host className={settingsWorkspaceStyles.root} style={{ padding: 24, maxWidth: 740, display: 'grid', gap: 24 }}>
    <section className="settings-overview-media-card" data-scrape-coverage-failed>
      <ScrapeCoverageBlock scraped={71} unscraped={22} failed={7} total={100} title="影片刮削覆盖" />
    </section>
    <section className="settings-overview-media-card" data-scrape-coverage-clean>
      <ScrapeCoverageBlock scraped={36} unscraped={14} total={50} title="演员刮削覆盖" />
    </section>
  </main>
}
function SettingsStatusCardsFixture() {
  return <main data-settings-status-host className={settingsWorkspaceStyles.root} style={{ padding: 24, maxWidth: 1100, container: 'settings-workspace / inline-size' }}>
    <SettingsPanel aria-label="状态">
      <SettingsPanelTitle standalone>状态</SettingsPanelTitle>
      <div className={settingsOverviewStyles.statusGrid} data-settings-status-grid>
        <SettingsStatusCard icon={FolderOpen} label="媒体库" value="3 个媒体库" detail="4 个来源目录 · 1,280 部影片"
          onClick={() => { window.lastStatusCard = 'library' }} />
        <SettingsStatusCard icon={Clapperboard} label="影片刮削" value="尚未设置默认刮削插件" detail="2 个插件"
          attention emphasizeValue onClick={() => { window.lastStatusCard = 'scraper' }} />
        <SettingsStatusCard icon={Wifi} label="局域网访问" value="已启用" detailLines={['本机可访问', '地址已配置']}
          onClick={() => { window.lastStatusCard = 'network' }} />
        <SettingsStatusCard icon={Palette} label="外观" valueVariant="theme"
          value={<span className={`theme-swatch theme-swatch-light ${settingsOverviewStyles.statusCardThemeSwatch}`} aria-hidden />}
          detail="浅色" onClick={() => { window.lastStatusCard = 'theme' }} />
      </div>
    </SettingsPanel>
  </main>
}
function AppUpdateFixture() {
  return <main data-app-update-host className={settingsWorkspaceStyles.root} style={{ padding: 24, maxWidth: 760, container: 'settings-workspace / inline-size' }}>
    <AppUpdatePanel />
  </main>
}
function SettingsWorkspaceShellFixture() {
  return <SettingsWorkspaceShell activeGroup={SETTINGS_GROUPS[0]} activeTab="status"
    onNavigate={(...args) => { window.lastWorkspaceNavigation = args }} onTabKeyDown={() => {}}>
    <AppUpdatePanel />
  </SettingsWorkspaceShell>
}
function PluginConnectionNoticeFixture() {
  return <PluginDevConnectionModal workloadLabel="刮削插件开发" providerLabel="测试提供方" modelLabel="示例模型"
    revision="1234567890abcdef" frozen={false} error="Agent 连接失败，请检查模型配置。"
    onOpenModelSettings={() => { window.lastNoticeAction = 'model' }} onClose={() => { window.lastNoticeAction = 'close' }} />
}
function ActressDeleteNoticeFixture() {
  return <ActressDeleteModal ids={[1]} subjectLabel="所选演员" onCancel={() => { window.lastNoticeAction = 'cancel' }} onDeleted={() => {}} />
}
function BatchOverviewFixture() {
  const handlers = { onPause: () => {}, onResume: () => {}, onDiscard: () => {} }
  return <main data-batch-overview-host className={settingsWorkspaceStyles.root} style={{ padding: 24, maxWidth: 760, display: 'grid', gap: 20 }}>
    <section data-batch-idle><BatchOverviewStatus scopeLabel="影片" batch={null} percent={0} showPending pendingGroupCount={3}
      onOpenPending={() => { window.lastBatchOverview = 'pending' }} onOpen={() => { window.lastBatchOverview = 'idle' }} {...handlers} /></section>
    <section data-batch-running><BatchOverviewStatus scopeLabel="影片"
      batch={{ status: 'running', current: 35, total: 100, currentCode: 'ABC-123', success: 30, failed: 2 }} percent={35}
      onOpen={() => { window.lastBatchOverview = 'running' }} {...handlers} /></section>
    <section data-batch-paused><BatchOverviewStatus scopeLabel="演员"
      batch={{ status: 'paused', current: 70, total: 100, success: 68, failed: 2 }} percent={70}
      canResume={false} resumeDisabledReason="状态范围无法识别，请终止后重新启动"
      onOpen={() => { window.lastBatchOverview = 'paused' }} {...handlers} /></section>
  </main>
}
function SettingsOverviewFixture({ empty = false }) {
  window.fixtureOverviewEmpty = empty
  const showNotices = new URLSearchParams(location.search).get('page') === 'settingsOverviewNotices'
  const notices = showNotices ? [
    { tone: 'warning', title: '媒体库需要维护', body: '有 2 个来源目录不可用，请检查路径。', actionLabel: '查看媒体库', action: () => { window.lastNoticeAction = 'library' }, actionPrimary: true },
    { tone: 'info', title: '远程访问已启用', body: '局域网设备可以访问媒体库。', secondaryActionLabel: '查看设置', secondaryAction: () => { window.lastNoticeAction = 'network' } }
  ] : []
  const settings = { defaultScraper: 'JavDB', defaultActressScraper: 'GFriends', proxyUrlEnabled: false, proxyUrl: '', llmProxyUrlEnabled: false, llmProxyUrl: '', mediaAssetsPath: '', mediaAssetsResolvedPath: '/fixture/assets', assetEncryption: false }
  return <main data-settings-overview-host className={settingsWorkspaceStyles.root} style={{ padding: 24, maxWidth: 1080, container: 'settings-workspace / inline-size' }}>
    <SettingsOverviewPanel settings={settings} theme={document.documentElement.dataset.theme} themeLabel="当前主题" notices={notices}
      videoPluginCount={2} actressPluginCount={1} videoBatch={null} actressBatch={null} anyBatchActive={false}
      videoBatchPct={0} actressPct={0} actressConflictGroupCount={empty ? 0 : 3}
      mediaLibraryCount={1} mediaLibraryRootCount={empty ? 0 : 2} mediaLibrariesLoading={false} mediaLibrariesError={false}
      onNavigate={(...args) => { window.lastSettingsOverviewAction = ['navigate', ...args] }}
      onOpenMediaLibrarySettings={() => { window.lastSettingsOverviewAction = ['libraries'] }}
      onOpenAgentTool={() => { window.lastSettingsOverviewAction = ['agent'] }}
      onStartVideoBatchDefault={() => { window.lastSettingsOverviewAction = ['videoDefault'] }}
      onStartActressBatchDefault={() => { window.lastSettingsOverviewAction = ['actressDefault'] }}
      onOpenVideoBatchAdvanced={() => { window.lastSettingsOverviewAction = ['videoAdvanced'] }}
      onOpenActressBatchAdvanced={() => { window.lastSettingsOverviewAction = ['actressAdvanced'] }}
      onOpenVideoBatchDetails={() => {}} onOpenActressBatchDetails={() => {}} onOpenActressConflicts={() => {}}
      onPauseVideoBatch={() => {}} onPauseActressBatch={() => {}} onResumeBatch={() => {}}
      onDiscardVideoBatch={() => {}} onDiscardActressBatch={() => {}} />
  </main>
}
function ClassificationPickerErrorFixture() {
  const [value, setValue] = useState('示例机构')
  return <main data-classification-picker-error-host style={{ padding: 24, maxWidth: 700 }}>
    <ClassificationPicker id="classification-error-fixture" value={value} options={[]} selectedId={null}
      listLabel="机构候选" error="机构候选加载失败，请稍后重试。" onValueChange={setValue} onSelect={() => {}} />
  </main>
}
function DetailPaneFixture() {
  return <div data-pane-host style={{ display: 'flex', height: 320, padding: 24 }}>
    <DetailPane stacked>
      <div data-pane-base style={{ padding: 24 }}>底层详情内容</div>
      <DetailPaneOverlay><div style={{ padding: 24 }}>叠层详情内容</div></DetailPaneOverlay>
    </DetailPane>
  </div>
}
function DetailScrollFixture() {
  return <div data-scroll-host style={{ display: 'flex', height: 440 }}>
    <DetailScrollBody onBack={() => {}}>
      <EmptyState variant="compact" title="详情空状态" />
      <EmptyState variant="gallery" title="样张空状态" />
    </DetailScrollBody>
  </div>
}
const actressMetaFixture = {
  main_name: '示例演员', name_zh: '示例中文名', name_en: 'Example Actress', names: [], aliases: ['别名一', '别名二'],
  gender: 'female', scraped_status: 0, last_scraped_at: null, height_cm: 165, bust_cm: 85, waist_cm: 60,
  hip_cm: 88, cup_size: 'C', birth_date: '1998-01-01', debut_date: '2018-01-01', nationality: '日本',
  blood_type: 'A', zodiac: '摩羯座', profile_summary: '一段可复制的演员资料摘要。', links: []
}
function ActressProfileMetaFixture() {
  return <div data-actress-meta-host style={{ display: 'flex', height: 600 }}>
    <DetailScrollBody><ActressProfileMeta actress={actressMetaFixture} /></DetailScrollBody>
  </div>
}
function ActressHeaderFixture() {
  const [tab, setTab] = useState('videos')
  return <div data-actress-header-host style={{ display: 'flex', height: 640 }}>
    <DetailScrollBody onBack={() => {}}>
      <div className={actressDetailStyles.layout}>
        <div className={actressDetailStyles.header} data-actress-header>
          <div className={actressDetailStyles.avatarFrame} data-preview="true" role="button" tabIndex={0} aria-label="查看原图：示例演员">
            <ActressAvatar src={null} name="示例演员" gender="female" size="detail" className={actressDetailStyles.avatar} />
          </div>
          <div className={actressDetailStyles.head}>
            <h1 className={`${detailTitleStyles.title} ${actressDetailStyles.title}`}>示例演员</h1>
            <p className={actressDetailStyles.subtitle}>示例中文名 · Example Actress</p>
            <div className={actressDetailStyles.stats} aria-label="概要"><DetailInfoChip variant="stat">24 部</DetailInfoChip><DetailInfoChip variant="stat">165 cm</DetailInfoChip></div>
          </div>
          <div className={actressDetailStyles.actions}><DetailActionBar ariaLabel="演员操作" variant="inline" className={actressDetailStyles.stickyActions}
            actions={[{ key: 'edit', label: '编辑', icon: <span aria-hidden>✎</span>, onClick: () => {} }]} /></div>
        </div>
        <ActressProfileMeta actress={actressMetaFixture} />
      </div>
      <div className={actressDetailStyles.tabs} role="tablist" aria-label="演员详情内容">
        <button type="button" role="tab" aria-selected={tab === 'videos'} className={actressDetailStyles.tab} onClick={() => setTab('videos')}>出演作品</button>
        <button type="button" role="tab" aria-selected={tab === 'gallery'} className={actressDetailStyles.tab} onClick={() => setTab('gallery')}>写真</button>
      </div>
    </DetailScrollBody>
  </div>
}
function VideoTitleFixture() {
  const [tall, setTall] = useState(false)
  return <div data-video-title-host style={{ padding: 24, containerType: 'inline-size', containerName: 'detail-page' }}>
    <article className={detailPageStyles.hero} data-video-hero>
      <div className={detailPageStyles.titleBlock}>
        <h1 className={`${detailTitleStyles.title} ${detailTitleStyles.video}`}><MetaLink>ABP-123</MetaLink> 这是一段用于验证影片详情标题在窄容器里会被截断而不会撑开版面的长标题示例，继续填充文字以覆盖两行显示</h1>
        <div className={detailPageStyles.titleBadges}>
          <ScrapeStatusBadge status={0}>未刮削</ScrapeStatusBadge>
          <PendingScrapeBadge onClick={() => {}}>查看待确认候选</PendingScrapeBadge>
          <span className={detailPageStyles.scrapeHint}>可在<MetaLink className={detailPageStyles.scrapeHintLink} data-scrape-hint-link>设置 · 概览</MetaLink>一键刮削全局目录中的未刮削影片。</span>
        </div>
      </div>
      <div className={detailPageStyles.heroBody} data-hero-body>
        <div className={`${detailPageStyles.cover} ${detailPageStyles.coverPreview}`} data-video-cover role="button" tabIndex={0} aria-label="查看封面：ABP-123">
          <img src={tall ? 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="240"><rect width="100" height="240" fill="teal"/></svg>') : galleryFixtureSrc} alt="ABP-123" className={tall ? detailPageStyles.coverTall : undefined} />
        </div>
        <div className={detailPageStyles.info}><p>影片信息区</p><button type="button" onClick={() => setTall(value => !value)}>切换竖版封面</button></div>
      </div>
    </article>
  </div>
}
function VideoResourcesFixture() {
  const resources = [
    { id: 1, library_id: 1, video_id: 1, root_id: null, kind: 'local', size_bytes: 1073741824, duration_seconds: 3661, file_mtime_ms: null, display_name: 'ABP-123.mp4', strm_source_path: null, is_primary: 1, add_time: '2026-01-01', display_locator: '/Volumes/Movies/ABP-123.mp4' },
    { id: 2, library_id: 1, video_id: 1, root_id: null, kind: 'web', size_bytes: null, duration_seconds: null, file_mtime_ms: null, display_name: '备用在线播放入口', strm_source_path: null, is_primary: 0, add_time: '2026-01-01', display_locator: 'example.com/ABP-123' }
  ]
  return <div data-video-resources-host style={{ padding: 24, containerType: 'inline-size', containerName: 'detail-page' }}>
    <VideoDetailSecondaryMeta video={{ resources }} onAddResource={() => {}} onReadResourceLocator={async () => 'https://example.com/full/ABP-123?token=example'} />
  </div>
}
function VideoMetaFixture() {
  const video = {
    release_date: '2026-09-28', resolved_duration_seconds: 3661,
    maker: '演示制作商', maker_organization_id: 1,
    publisher: '演示发行商', publisher_organization_id: 2,
    series: '示例系列', series_id: 3, director: '示例导演', director_id: 4,
    scraped_status: 0, last_scraped_at: '2026-09-27T12:30:00Z',
    updated_at: '2026-09-28T10:30:00Z', add_time: '2026-09-26T10:30:00Z'
  }
  return <div data-video-meta-host style={{ padding: 24, containerType: 'inline-size', containerName: 'detail-page' }}>
    <VideoDetailPrimaryMeta video={video} />
    <VideoMaintenanceInfo video={video} />
  </div>
}
function DetailActionsFixture() {
  const [busy, setBusy] = useState(false)
  return <div data-detail-actions-host style={{ padding: 24, containerType: 'inline-size', containerName: 'detail-page' }}>
    <DetailActionBar ariaLabel="影片操作" primary={{ label: '播放', icon: <span aria-hidden>▶</span>, onClick: () => {} }}
      actions={[{ key: 'edit', label: '编辑', icon: <span aria-hidden>✎</span>, busy, onClick: () => setBusy(true) }]}
      menuItems={[{ key: 'rename', label: '重命名', onClick: () => {} }, { key: 'separator', type: 'separator' }, { key: 'delete', label: '删除影片', danger: true, onClick: () => {} }]} />
    <DetailActionBar ariaLabel="演员操作" variant="inline"
      actions={[{ key: 'edit', label: '编辑演员', icon: <span aria-hidden>✎</span>, onClick: () => {} }]} />
  </div>
}
const galleryFixtureSrc = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#3678aa"/><circle cx="200" cy="120" r="80" fill="#d2a976"/></svg>')
function GalleryTilesFixture() {
  return <main data-gallery-host style={{ padding: 24, maxWidth: 740 }}>
    <DetailSection>
      <div className={videoGalleryStyles.masonry} style={{ maxWidth: 320 }}><div className={videoGalleryStyles.column}>
        <GalleryImageTile variant="sample" src={galleryFixtureSrc} label="样张示例" disabled={false} onOpen={() => {}}
          deleteLabel="删除样张示例" deleteTitle="删除样张示例" onDelete={() => {}} />
      </div></div>
      <EmptyState variant="gallery" title="暂无样张" />
    </DetailSection>
    <div className={actressGalleryStyles.masonry} style={{ height: 210, maxWidth: 320 }}>
      <GalleryImageTile variant="actress" src={galleryFixtureSrc} label="写真示例" disabled={false} onOpen={() => {}}
        deleteLabel="删除写真示例" deleteTitle="删除写真示例" onDelete={() => {}} style={{ width: 320, height: 192 }} />
    </div>
  </main>
}
function ListDetailShellFixture() {
  return <div data-list-shell-host style={{ display: 'flex', height: 440, padding: 24 }}>
    <Routes>
      <Route path="/fixture" element={<ListDetailShell list={<div data-list-shell-base style={{ padding: 24 }}>列表内容</div>} detailMatchPath="/fixture/:id" />}>
        <Route path=":id" element={<div style={{ padding: 24 }}>详情内容</div>} />
      </Route>
    </Routes>
  </div>
}
function PlaylistCards() {
  const [active, setActive] = useState(1)
  const [selected, setSelected] = useState(false)
  const items = [
    { id: 1, name: '封面清单', description: '两行以内的清单简介', preview_cover_path: 'fixture.svg', video_count: 8 },
    { id: 2, name: '无封面清单', description: null, preview_cover_path: null, video_count: 0 }
  ]
  return <main style={{ padding: 24, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(260px, 1fr))', gap: 12 }}>
    {items.map(item => <PlaylistCard key={item.id} item={item} active={active === item.id} onOpen={() => setActive(item.id)} />)}
    <PlaylistPickerRow item={items[0]} action={<Button size="sm" onClick={() => {}}>加入</Button>} />
    <PlaylistPickerRow item={items[1]} selected={selected} onSelect={() => setSelected(value => !value)} />
  </main>
}
function ActressTile() {
  const [selected, setSelected] = useState(false)
  return <div style={{ width: 150 }}><ActressCardTile actress={{ id: 1, main_name: '测试演员', gender: 'female', avatar_path: null, video_count: 0, scraped_status: 1 }}
    selected={selected} selectionMode={false} onToggleSelect={() => setSelected(value => !value)} onOpen={() => {}} onDelete={() => {}} /></div>
}
const { DisplayModeProvider, useDisplayMode } = await import('../../apps/desktop/src/renderer/src/components/DisplayModeContext')
function Covers() {
  const { setMode } = useDisplayMode()
  return <main style={{ padding: 24 }}>
    <button onClick={() => setMode('landscape')}>横版封面</button>
    <div style={{ display: 'flex', gap: 24, width: 600 }}>
      {[undefined, 180].map((height, index) => <div key={index} style={{ width: 260 }}>
        <PosterCard video={{ id: index + 1, code: `COVER-${index}`, title: '封面验证', cover_path: 'fixture.svg', scraped_status: 0 }} thumbHeight={height} />
      </div>)}
    </div>
  </main>
}
const videos = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, code: `TEST-${index + 1}`, title: `布局验证影片 ${index + 1}`, cover_path: null, scraped_status: 0 }))
function Grid() {
  const [selected, setSelected] = useState(new Set())
  const [selectionMode, setSelectionMode] = useState(true)
  const [action, setAction] = useState('')
  const [builtinActions, setBuiltinActions] = useState(false)
  window.fixtureBuiltinMemberships ??= new Set()
  window.api.playlists.listForVideo = async videoId => ['favorites', 'watch_later'].map((system_kind, index) => ({
    id: index + 1, generation: 1, revision: 1, system_kind,
    contains_video: window.fixtureBuiltinMemberships.has(`${index + 1}:${videoId}`)
  }))
  window.api.playlists.addVideo = async (playlistId, videoId) => { window.fixtureBuiltinMemberships.add(`${playlistId}:${videoId}`); return true }
  window.api.playlists.removeVideo = async (playlistId, videoId) => { window.fixtureBuiltinMemberships.delete(`${playlistId}:${videoId}`); return true }
  return <><VirtualPosterGrid videos={videos} selectionMode={selectionMode} selectedIds={selected} builtinActions={builtinActions ? 'all' : undefined}
    onEdit={() => setAction('编辑已触发')} onDelete={() => setAction('删除已触发')}
    onToggleSelect={video => setSelected(previous => {
      const next = new Set(previous)
      if (next.has(video.id)) next.delete(video.id)
      else next.add(video.id)
      return next
    })} /><button style={{ position: 'fixed', right: 24, bottom: 16, zIndex: 10 }} onClick={() => setSelectionMode(false)}>浏览模式</button><button style={{ position: 'fixed', right: 120, bottom: 16, zIndex: 10 }} onClick={() => setBuiltinActions(true)}>默认清单操作</button><output style={{ position: 'fixed', right: 24, bottom: 48 }}>{action}</output></>
}
function Controls() {
  const [selected, setSelected] = useState('女')
  const [choice, setChoice] = useState('first')
  const select = label => <SelectControl aria-label={label} value={choice} onChange={event => setChoice(event.target.value)}>
    <option value="first">首项</option><option value="disabled" disabled>禁用选项</option><option value="last">末项</option>
  </SelectControl>
  return <main style={{ padding: 24, display: 'grid', gap: 24, color: 'var(--text-primary)', '--toolbar-control-h': '36px' }}>
    {['default', 'toolbar', 'stretch'].map(variant => <section key={variant}>
      <h2>{variant}</h2>
      <SegmentedControl variant={variant} aria-label={variant}>
        {['女', '男'].map(label => <SegmentedOption key={label} selected={selected === label} onClick={() => setSelected(label)}>{label}</SegmentedOption>)}
        <SegmentedOption selected={false} disabled>不可用</SegmentedOption>
      </SegmentedControl>
    </section>)}
    <div style={{ display: 'flex', gap: 24 }}>
      <div style={{ width: 240 }}>{select('下方展开')}</div>
      <div className={settingsWorkspaceStyles.root} style={{ width: 240, padding: 0 }}>{select('设置选择')}</div>
    </div>
    <ActressTile />
    <div data-media-tile aria-label="操作显隐测试" style={{ position: 'relative', width: 100, height: 60 }}>
      <MediaTileActionButton action="remove" label="移除测试图片" onClick={() => {}} />
    </div>
    <div style={{ position: 'fixed', width: 240, bottom: 16, left: 24 }}>{select('上方展开')}</div>
  </main>
}
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'graphite'
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={query}><MemoryRouter initialEntries={params.get('page')?.startsWith('videoDetail') ? ['/libraries/3/video/1'] : params.get('page') === 'playlistDetail' ? ['/playlists/1'] : params.get('page') === 'listDetailShell' ? ['/fixture/1'] : ['/']}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    {params.get('page') === 'sharedChrome' ? <SharedChromeFixture /> : params.get('page')?.startsWith('settingsDensity') ? <SettingsDensityFixture variant={params.get('page')} /> : params.get('page')?.startsWith('nativeEditor') ? <NativeEditorsFixture variant={params.get('page')} /> : params.get('page')?.startsWith('videoDetail') ? <DetailOperationsFixture variant={params.get('page')} /> : params.get('page')?.startsWith('resourceImport') ? <ResourceImportFixture variant={params.get('page')} /> : params.get('page')?.startsWith('appearance') ? <AppearanceFixture variant={params.get('page')} /> : params.get('page')?.startsWith('imagePreview') ? <ImagePreviewFixture variant={params.get('page')} /> : params.get('page')?.startsWith('delete') ? <DeleteConfirmationFixture kind={params.get('page')} /> : params.get('page') === 'galleryPaging' ? <GalleryPagingFixture /> : params.get('page') === 'avatarGalleryPaging' ? <ActressAvatarEditorFixture /> : params.get('page') === 'classificationMerge' ? <ClassificationMergeFixture /> : params.get('page') === 'classificationMergeEmpty' ? <ClassificationMergeFixture state="empty" /> : params.get('page') === 'classificationMergeError' ? <ClassificationMergeFixture state="error" /> : params.get('page') === 'directorChoice' ? <DirectorChoiceFixture /> : params.get('page')?.startsWith('actressMerge') ? <ActressMergeFixture /> : params.get('page') === 'actressConflict' ? <ActressConflictFixture /> : params.get('page') === 'conflictMerge' ? <ConflictMergeFixture /> : params.get('page') === 'conflictMergeBlocked' ? <ConflictMergeFixture blocked /> : params.get('page') === 'selection' ? <Selection /> : params.get('page') === 'imageImport' ? <ImageImport /> : params.get('page') === 'imageImportField' ? <ImageImportFieldFixture /> : params.get('page') === 'actressAvatarEditor' ? <ActressAvatarEditorFixture /> : params.get('page') === 'scrapeFieldsModal' ? <ScrapeFieldsModalFixture /> : params.get('page') === 'batchSettingsEmpty' ? <BatchSettingsPanelFixture state="empty" /> : params.get('page') === 'batchSettingsRunning' ? <BatchSettingsPanelFixture state="running" /> : params.get('page') === 'batchSettingsPaused' ? <BatchSettingsPanelFixture state="paused" /> : params.get('page') === 'settingsEmptyVariants' ? <SettingsEmptyVariantsFixture /> : params.get('page') === 'settingsLoading' ? <SettingsLoadingFixture /> : params.get('page') === 'pluginsSettingsEmpty' ? <PluginsSettingsFixture empty /> : params.get('page') === 'pluginsSettingsCards' ? <PluginsSettingsFixture /> : params.get('page') === 'pluginConfigBuiltin' ? <PluginConfigFixture variant="builtin" /> : params.get('page') === 'pluginConfigUser' ? <PluginConfigFixture variant="user" /> : params.get('page') === 'batchTaskControls' ? <BatchTaskControlsFixture /> : params.get('page') === 'scrapeCoverage' ? <ScrapeCoverageFixture /> : params.get('page') === 'settingsStatusCards' ? <SettingsStatusCardsFixture /> : params.get('page') === 'batchOverview' ? <BatchOverviewFixture /> : params.get('page') === 'settingsWorkspaceShell' ? <SettingsWorkspaceShellFixture /> : params.get('page') === 'appUpdate' || params.get('page') === 'appUpdateIgnored' ? <AppUpdateFixture /> : params.get('page') === 'pluginConnectionNotice' ? <PluginConnectionNoticeFixture /> : params.get('page') === 'actressDeleteNotice' ? <ActressDeleteNoticeFixture /> : params.get('page') === 'settingsOverviewNotices' ? <SettingsOverviewFixture /> : params.get('page') === 'settingsOverview' ? <SettingsOverviewFixture /> : params.get('page') === 'settingsOverviewEmpty' ? <SettingsOverviewFixture empty /> : params.get('page') === 'classificationCards' ? <ClassificationCardsFixture /> : params.get('page') === 'aliasTagEditor' ? <AliasTagEditorFixture /> : params.get('page') === 'pluginFieldTags' ? <PluginDevFieldTagsFixture /> : params.get('page') === 'pluginDevConfigCreate' ? <PluginDevConfigRailFixture /> : params.get('page') === 'pluginDevConfigDebug' ? <PluginDevConfigRailFixture debug /> : params.get('page') === 'pluginDevTargetVideo' ? <PluginDevTargetFixture kind="video" /> : params.get('page') === 'pluginDevTargetActress' ? <PluginDevTargetFixture kind="actress" /> : params.get('page') === 'pluginDevConversationActive' ? <PluginDevConversationFixture active /> : params.get('page') === 'pluginDevConversationEmpty' ? <PluginDevConversationFixture /> : params.get('page') === 'pluginDevAgentRail' ? <PluginDevAgentRailFixture /> : params.get('page') === 'pluginDevWorkspaceSettings' ? <PluginDevWorkspaceFixture settings /> : params.get('page') === 'pluginDevWorkspaceStandalone' ? <PluginDevWorkspaceFixture /> : params.get('page') === 'appFormField' ? <AppFormFieldFixture /> : params.get('page') === 'codeEditorSyntax' ? <CodeEditorFixture /> : params.get('page') === 'pluginDevCodeModal' ? <PluginDevCodeModalFixture /> : params.get('page') === 'pluginDevKindToggle' ? <PluginDevKindToggleFixture /> : params.get('page') === 'entityEditForm' ? <EntityEditFormFixture /> : params.get('page') === 'entityMediaSection' ? <EntityMediaSectionFixture /> : params.get('page') === 'classificationPickerError' ? <ClassificationPickerErrorFixture /> : params.get('page') === 'classificationDetailLayout' ? <ClassificationDetailLayoutFixture /> : params.get('page')?.startsWith('classificationProfile') ? <ClassificationProfileFixture kind={params.get('page').replace('classificationProfile', '')} /> : params.get('page') === 'relatedLinksEditor' ? <RelatedLinksEditorFixture /> : params.get('page') === 'detailActions' ? <DetailActionsFixture /> : params.get('page') === 'detailSections' ? <DetailSectionsFixture /> : params.get('page') === 'videoTags' ? <VideoTagsFixture /> : params.get('page') === 'videoInfo' ? <VideoInfoFixture /> : params.get('page') === 'videoMeta' ? <VideoMetaFixture /> : params.get('page') === 'videoResources' ? <VideoResourcesFixture /> : params.get('page') === 'videoTitle' ? <VideoTitleFixture /> : params.get('page') === 'actressHeader' ? <ActressHeaderFixture /> : params.get('page') === 'actressProfileMeta' ? <ActressProfileMetaFixture /> : params.get('page') === 'galleryTiles' ? <GalleryTilesFixture /> : params.get('page') === 'listDetailShell' ? <ListDetailShellFixture /> : params.get('page') === 'detailScroll' ? <DetailScrollFixture /> : params.get('page') === 'detailPane' ? <DetailPaneFixture /> : params.get('page') === 'detailTitles' ? <DetailTitles /> : params.get('page') === 'playlistDetail' ? <PlaylistImportProvider><Routes><Route path="/playlists/:playlistId" element={<PlaylistDetailPage />} /></Routes></PlaylistImportProvider> : params.get('page') === 'playlistPicker' ? <PlaylistVideoPicker videoIds={[1]} single subtitle="测试影片" onCancel={() => {}} /> : params.get('page') === 'crypto' ? <AssetCryptoOverlay /> : params.get('page') === 'faceScan' ? <FaceScan /> : params.get('page') === 'actressGrid' ? <ActressGrid /> : params.get('page') === 'playlistCards' ? <PlaylistCards /> : params.get('page') === 'covers' ? <DisplayModeProvider><Covers /></DisplayModeProvider> : params.get('page') === 'grid' ? <Grid /> : params.get('page') === 'controls' ? <Controls /> : params.get('page') === 'search' ? <GlobalSearchPage /> : <HomePage />}
    </div>
  </MemoryRouter></QueryClientProvider>
)
