import React from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { DEFAULT_SETTINGS } from '@shared/settingsTypes'
import { DEFAULT_MEDIA_LIBRARY_CONFIG } from '@shared/mediaLibraryTypes'
import { actressProfileSchema, scopedVideoDetailSchema } from '@shared/catalogDetailSchemas'
import { DEFAULT_NFO_EXPORT_PREFERENCES } from '@shared/nfoExportTypes'
import '../../apps/desktop/src/renderer/src/styles/global.css'

// Exercise the production App, route tree and providers. Only the preload interface is replaced;
// no production transforms, synthetic page layout, account data or Electron IPC are used.
window.React = React
const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'ready'
const theme = params.get('theme') ?? 'graphite'
const scenario = params.get('scenario') ?? ''
const pendingScenario = scenario.startsWith('pending-')
const pluginDevScenario = scenario === 'plugin-dev'
const stackScenario = scenario.startsWith('stack-')
const catalogState = stackScenario ? 'ready' : state
window.fixtureCalls = []
window.fixtureUnexpected = []
const subscribe = () => () => {}
const settings = { ...structuredClone(DEFAULT_SETTINGS), theme, actressDetailUseFirstGalleryBackground: false,
  mediaAssetsResolvedPath: '/fixture/图片资料/用于检查较长路径的合成目录', recoveryNotice: null,
  llmSecretStorage: { protection: 'secure', backend: 'fixture' } }
const library = {
  id: 3, name: '样式验收媒体库：较长中文名称', icon: 'film', color: 'blue', position: 0,
  status: 'active', isDefault: false, revision: 1, createdAt: '2026-09-30', updatedAt: '2026-09-30',
  config: { ...DEFAULT_MEDIA_LIBRARY_CONFIG, libraryId: 3, revision: 1 }, roots: [],
  rootCount: 0, activeRootCount: 0, pendingRemovalRootCount: 0, pendingCleanupJobCount: 0,
  pendingScanGroupCount: 0, disabledRootCount: 0, archivedRootCount: 0
}
const videos = Array.from({ length: 48 }, (_, index) => ({
  id: index + 1, code: `FIX-${String(index + 1).padStart(3, '0')}`,
  title: `样式验收影片 ${index + 1}：用于检查较长中文标题及网格边界`, cover_path: null,
  scraped_status: index % 3, has_pending_scrape: false, resource_kinds: ['local'],
  preferredLibraryId: 3, membershipAddedAt: '2026-09-30',
  libraries: [{ libraryId: 3, name: library.name, icon: library.icon, color: library.color }]
}))
const actresses = Array.from({ length: 96 }, (_, index) => ({
  id: index + 1, main_name: `样式验收演员 ${index + 1}：长名称`, avatar_path: null,
  gender: index % 2 ? 'male' : 'female', scraped_status: index % 3, video_count: index + 1,
  revision: 1, avatar_fingerprint: null
}))
const overview = { videos: { total: 48, scraped: 16, unscraped: 16, failed: 16 },
  actresses: { total: 96, female: 48, male: 48, scraped: 32, unscraped: 32, failed: 32 },
  playlists: 4, tags: 0, galleryAssets: 0, facets: { directors: 4, makers: 4, publishers: 4, series: 4 } }
const classifications = Array.from({ length: 48 }, (_, index) => ({ id: index + 1,
  mainName: `样式验收分类 ${index + 1}：较长中文名称`, imagePath: null, fallbackCoverPath: null,
  videoCount: index + 1, aliases: [], revision: 1, generation: 1, role: 'maker' }))
const playlists = Array.from({ length: 48 }, (_, index) => ({ id: index + 1,
  name: `样式验收清单 ${index + 1}：较长中文名称`, description: '较长的清单说明，用于验证卡片截断。',
  preview_cover_path: null, cover_path: null, video_count: index + 1, contains_video: false }))
const videoDetail = scopedVideoDetailSchema.parse({
  ...videos[0], generation: 1, revision: 1, title: '样式验收影片详情：较长中文标题',
  activeLibraryId: 3, summary: '详情说明与可复制元数据，用于检查滚动和长文本。',
  poster_path: null, original_title: null, rating: 3, release_date: '2026-09-20',
  maker: null, publisher: null, director: null, series: null, maker_organization_id: null,
  publisher_organization_id: null, director_id: null, series_id: null, duration_seconds: 7200,
  last_scraped_at: null, updated_at: null, add_time: '2026-09-20T08:00:00Z',
  external_stats: [], actresses: [], tags: [], links: [], assets: [], resource_count: 1,
  primary_resource_kind: 'local', resolved_duration_seconds: 7200,
  resources: [{ id: 11, video_id: 1, library_id: 3, root_id: 1, kind: 'local',
    display_name: '较长的影片资源文件名.mp4',
    display_locator: '/fixture/影片资料/较长中文目录/仅用于显示的合成资源文件.mp4',
    strm_source_path: null, is_primary: 1, size_bytes: 2147483648, duration_seconds: 7200,
    file_mtime_ms: null, add_time: '2026-09-20T08:00:00Z' }]
})
const actressProfile = actressProfileSchema.parse({
  ...actresses[0], main_name: '样式验收演员详情：较长中文名称', generation: 1,
  avatar_source_path: null, avatar_crop_json: null, poster_path: null, birth_date: null,
  debut_date: null, height_cm: null, bust_cm: null, waist_cm: null, hip_cm: null,
  cup_size: null, blood_type: null, zodiac: null, nationality: null,
  profile_summary: '较长的演员资料说明，用于检查详情文字和关联影片。',
  last_scraped_at: null, updated_at: null, name_zh: null, name_en: null,
  aliases: ['合成别名'], names: [], links: [], gallery_count: 0, display_gallery_count: 0, first_gallery: null
})
const classificationDetail = {
  ...classifications[0], updatedAt: '2026-09-30', mainName: '样式验收分类详情：较长中文名称',
  aliases: ['合成别名'], summary: '用于验收元数据、操作栏、关联影片以及详情区域滚动。',
  countryRegion: null, birthDate: null, deathDate: null, birthPlace: null,
  careerStartYear: null, careerEndYear: null, foundedYear: null, endedYear: null,
  status: 'unknown', links: [], releaseYearStart: null, releaseYearEnd: null,
  ownerOrganization: null, parentSeries: null, startYear: null, endYear: null,
  parent: null, roles: ['maker', 'publisher'], makerVideoCount: 48, publisherVideoCount: 48
}
const scanGroup = { id: 11, libraryId: 3, normalizedCode: 'FIX-001', revision: 1,
  createdAt: '2026-09-30', updatedAt: '2026-09-30',
  resources: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, libraryId: 3, groupId: 11, rootId: 1,
    filePath: `/fixture/扫描资料/较长中文目录/用于检查资源归属与路径换行/FIX-001-${index + 1}.mp4`,
    sourceKind: 'local', targetKind: null, targetDisplay: null, displayName: `FIX-001-合成资源-${index + 1}.mp4`,
    sizeBytes: 2147483648, durationSeconds: 7200, fileMtimeMs: null })) }
const resourceIdentity = { id: 12, libraryId: 3, rootId: 1, sourceKind: 'local', targetKind: null,
  targetDisplay: null, displayName: 'FIX-001-待确认番号的较长文件名.mp4', filenameCode: 'FIX-001',
  nfoCode: 'NFO-002', revision: 1, createdAt: '2026-09-30', updatedAt: '2026-09-30' }
const pendingScrape = { id: 21, videoId: 1, revision: 1, selectedFields: ['title', 'summary'],
  applicableFields: ['title', 'summary'], updateMode: 'fillEmpty', warnings: [],
  createdAt: '2026-09-30', updatedAt: '2026-09-30', stagedBytes: 0,
  sources: [{ id: 1, position: 0, pluginName: '合成影片来源', pluginSource: 'user', pluginVersion: '1.0.0',
    sourceName: '合成来源', selectedFields: ['title', 'summary'], selectedCandidateId: null,
    candidates: Array.from({ length: 4 }, (_, index) => ({ id: index + 1, position: index,
      result: { code: 'FIX-001', title: `合成候选 ${index + 1}：较长中文标题`, summary: '候选说明用于核对文字与影响区域。' },
      sourceUrl: null, stagedCoverPath: null, stagedSamplePaths: [], stagedActressAvatarPaths: [] })) }] }
const conflictClaimant = { actressId: 2, revision: 1, mainName: '合成现有演员', avatarPath: null,
  nameTypes: ['alias'], hasPendingScrape: false }
const conflictGroup = { status: 'conflict', normalizedName: '合成共享名称', displayName: '合成共享名称',
  currentOwner: conflictClaimant, claimants: [conflictClaimant], pendingNameClaims: [],
  candidates: [{ pendingId: 31, revision: 1, actressId: 1, actressRevision: 1,
    actressMainName: '合成候选演员', actressAvatarPath: null, plugin: { name: '合成演员来源', source: 'user' },
    queryName: '合成共享名称', selectedFields: ['aliases'], applicableFields: ['aliases'], mode: 'fillEmpty',
    result: { mainName: '合成候选演员', aliases: ['合成共享名称'], profileSummary: '用于核对名称归属及资料影响。' },
    warnings: [], createdAt: '2026-09-30', resources: [],
    conflicts: [{ name: '合成共享名称', normalizedName: '合成共享名称', type: 'alias' }],
    fieldImpacts: [], fieldImpactsWhenAssignedToCandidate: [], willApplyAfterDecision: true,
    remainingConflictCountAfterDecision: 0 }] }
const scanQueue = [
  { id: 11, libraryId: 3, revision: 1, label: 'FIX-001', kind: 'group', resourceCount: 8 },
  { id: 12, libraryId: 3, revision: 1, label: 'FIX-001 / NFO-002', kind: 'identity', displayName: resourceIdentity.displayName }
]
const scrapeQueue = [{ id: 21, videoId: 1, revision: 1, code: 'FIX-001', candidateCount: 4, sourceCount: 1, stagedCoverPath: null }]
const conflictQueue = [{ normalizedName: conflictGroup.normalizedName, displayName: conflictGroup.displayName,
  status: 'conflict', candidateCount: 1, pendingNameClaimCount: 0, avatarPath: null }]
const pluginPackage = { schemaVersion: 1, kind: 'video', name: '合成开发插件', version: '1.0.0',
  description: '仅用于验证恢复工作区布局，不用于真实运行。', homepage: 'https://example.test',
  supportedFields: ['title'], code: 'module.exports = async ctx => ({ code: ctx.code, title: "合成资料" })' }
const pluginSnapshot = { cursor: 1, input: { mode: 'create', kind: 'video', siteName: pluginPackage.name,
  siteUrl: pluginPackage.homepage, supportedFields: ['title'] },
  result: { sessionId: 'fixture-plugin-session', status: 'waiting_user', package: pluginPackage,
    frozenModel: { providerId: 'fixture', modelId: 'fixture', modelName: '合成冻结模型', revision: 'fixture-1' },
    runTargets: [{ kind: 'video', code: 'FIX-001' }], summary: '合成恢复会话：等待反馈' },
  phase: 'working', step: 2, totalTokens: 128, events: [],
  workLog: Array.from({ length: 12 }, (_, index) => ({ at: '2026-09-30', kind: 'event',
    event: { type: 'assistant_text', sessionId: 'fixture-plugin-session', step: index + 1, turn: index + 1,
      text: `合成恢复消息 ${index + 1}：用于验证对话区域滚动、长中文与独立工作区。` } })) }
function detail(value, readState = catalogState) {
  if (readState === 'loading') return new Promise(() => {})
  if (readState === 'error') throw new Error('整页验收读取失败：较长中文说明与 /fixture/资料库/路径，请重试。')
  return readState === 'empty' ? null : value
}
async function videoPage(query, items = videos) {
  const page = await catalog(items, query)
  return { videos: page.items, total: page.total, filteredTotal: page.total,
    offset: page.offset, limit: page.limit }
}
function catalog(items, query = {}, extra = {}, readState = catalogState) {
  if (readState === 'loading') return new Promise(() => {})
  if (readState === 'error') throw new Error('整页验收读取失败：较长中文说明与 /fixture/资料库/路径，请重试。')
  const matching = readState === 'empty' ? [] : items.filter(item =>
    JSON.stringify(item).includes(query.search ?? '') &&
    (!query.gender || query.gender === 'all' || item.gender === query.gender) &&
    (query.scrapedStatus == null || query.scrapedStatus === 'all' || item.scraped_status === query.scrapedStatus))
  const offset = query.offset ?? 0
  const limit = query.limit ?? 60
  return { items: matching.slice(offset, offset + limit), total: matching.length,
    offset, limit, readRevision: 'fixture-1', ...extra }
}
const definitions = {
  home: { load: async input => ({ seed: input.seed, recent: videos.slice(0, 12), discovery: videos.slice(12, 24),
    libraries: [{ ...library, membershipCount: 48, resourceCount: 48, pendingScanResourceCount: 0,
      unrecognizedFileCount: 0, lastScanStatus: null, lastScanStartedAt: null, lastScanFinishedAt: null,
      lastSuccessfulScanAt: null, lastScanOfflineRootCount: null }] }),
    search: async query => catalog(videos, query) },
  mediaLibraries: { list: async () => [library], get: async () => library },
  settings: { get: async () => settings, getOverviewStats: async () => overview,
    getModelManagement: async () => {
      if (pluginDevScenario && state === 'loading') return new Promise(() => {})
      if (pluginDevScenario && state === 'error') throw new Error('开发工作区模型配置读取失败')
      return { schemaVersion: 3, revision: 'fixture-1', updatedAt: '2026-09-30',
      connections: [], models: [], validationErrors: [],
      assignments: ['app-default', 'plugin-developer', 'library-curator'].map(workloadId => ({
        workloadId, model: workloadId === 'app-default' ? { mode: 'explicit', modelRef: '' } : { mode: 'inherit-default' },
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120000 },
        limits: { maxTurns: 0, maxContextTokens: 128000 }, resolution: { ready: false, reason: '未配置模型' }
      })) }
    } },
  videos: { list: async (_scope, query) => catalog(videos, query), years: async () => [2026],
    get: async (_scope, id) => detail({ ...videoDetail, id, resources: videoDetail.resources.map(resource => ({ ...resource, video_id: id })) },
      scenario === 'stack-video' && id === 2 ? state : catalogState) },
  playlists: { listPage: async query => catalog(playlists, query, { hasExactName: false }),
    metadata: async () => detail({ id: 1, generation: 1, revision: 1,
      name: '样式验收清单详情：较长中文名称', description: '用于检查真实清单详情与连续影片列表。',
      preview_cover_path: null, cover_path: null, links: [], created_at: '2026-09-30', updated_at: null }),
    videoPage: async (_id, query) => videoPage(query) },
  directors: { page: async query => catalog(classifications, query), get: async () => detail(classificationDetail) },
  series: { page: async query => catalog(classifications, query), get: async () => detail(classificationDetail) },
  organizations: { page: async query => catalog(classifications, query), get: async () => detail(classificationDetail) },
  actresses: { listPage: async query => {
    const page = await catalog(actresses, query)
    return { ...page, statusCounts: { all: page.total, success: page.total / 3,
      unscraped: page.total / 3, failed: page.total / 3 } }
  }, profile: async id => detail({ ...actressProfile, id }, scenario === 'stack-actress' && id === 2 ? state : catalogState),
    videoPage: async (id, query) => videoPage(query, scenario !== 'stack-actress' ? videos :
      id === 2 ? videos.slice(0, 10) : Array.from({ length: 125 }, (_, index) => ({
        ...videos[index % videos.length], id: index + 1, code: `FIX-${String(index + 1).padStart(3, '0')}`
      }))),
    galleryPage: async (_id, query) => catalog([], query) },
  scrape: { countPending: async () => pendingScenario ? scrapeQueue.length : 0,
    pagePending: async query => catalog(pendingScenario ? scrapeQueue : [], query, {}, pendingScenario ? 'ready' : catalogState),
    getPending: async () => detail(pendingScrape),
    listPlugins: async () => [], listPluginDetails: async () => [], onVideoBatchProgress: subscribe,
    videoBatchCount: async () => 48 },
  actressScrape: { conflictSummary: async () => ({ groupCount: pendingScenario ? 1 : 0,
    conflictGroupCount: pendingScenario ? 1 : 0, applicableGroupCount: 0, pendingScrapeCount: pendingScenario ? 1 : 0, pendingNameClaimGroupCount: 0 }),
    pageConflicts: async query => catalog(pendingScenario ? conflictQueue : [], query, {}, pendingScenario ? 'ready' : catalogState),
    getConflict: async () => detail(conflictGroup),
    listPlugins: async () => [], listPluginDetails: async () => [], onBatchProgress: subscribe,
    onAvatarAutoCropRequest: subscribe, batchCount: async () => 48 },
  scan: { pagePendingQueue: async query => catalog(pendingScenario ? scanQueue : [], query, {}, pendingScenario ? 'ready' : catalogState),
    countPendingQueue: async () => pendingScenario ? scanQueue.length : 0,
    getPendingGroup: async () => detail(scanGroup), getPendingIdentity: async () => detail(resourceIdentity),
    getAuditHeader: async () => null, onProgress: subscribe, onStateChanged: subscribe },
  batchScrape: { getState: async () => ({ kind: null, progress: null, recoverable: true }) },
  assetCrypto: { onProgress: subscribe },
  playlistImport: { onSnapshotChanged: subscribe },
  agentMetadata: { onSnapshotChanged: subscribe },
  pluginDev: { snapshot: async () => detail(pluginSnapshot), onAgentEvent: subscribe,
    releaseBrowser: async () => {}, discardUnrecoverableSessions: async () => {} },
  appUpdate: { getState: async () => ({ status: 'up-to-date', currentVersion: '0.8.0' }),
    onStateChanged: subscribe },
  thisComputer: { get: async () => ({ mode: 'local', remoteBaseUrl: null, closeToTray: false,
    theme, playerPath: null, proxyUrl: '', proxyUrlEnabled: false, llmProxyUrl: '', llmProxyUrlEnabled: false }) },
  backup: { control: async input => {
    if (input.action !== 'list') throw new Error(`Write command is not allowed: backup.${input.action}`)
    return { jobs: [] }
  } },
  nfoExport: { getOptions: async () => ({ libraries: [{ id: library.id, name: library.name }],
    profiles: [{ id: 'portable-v1', label: '通用 / Kodi', description: '合成兼容格式说明' }],
    preferences: { ...DEFAULT_NFO_EXPORT_PREFERENCES } }), onProgress: subscribe, onState: subscribe },
  webAccess: { status: async () => ({ enabled: false, running: false, port: 8096, username: 'viewer',
    hasPassword: false, urls: [], devices: [], pairingUntil: 0, pairingActivity: [], sessions: 0, error: null }) }
}
// Unknown calls must fail even if a production hook catches the exception. Never silently
// manufacture successful empty responses for an unimplemented contract or write command.
function strictApi(object, prefix = '') {
  return new Proxy(object, { get(target, key) {
    if (typeof key !== 'string') return Reflect.get(target, key)
    const name = prefix ? `${prefix}.${key}` : key
    if (!(key in target)) {
      if (name === 'desktop') return undefined // Production supports older local preload sessions.
      window.fixtureUnexpected.push(name)
      throw new Error(`Unimplemented fixture API: ${name}`)
    }
    const value = target[key]
    if (typeof value === 'function') return (...args) => {
      window.fixtureCalls.push({ name, args })
      return value(...args)
    }
    return strictApi(value, name)
  } })
}
window.api = strictApi(definitions)
const { default: App } = await import('../../apps/desktop/src/renderer/src/App')
const { default: QueryProvider } = await import('../../apps/desktop/src/renderer/src/query/QueryProvider')
const { queryClient } = await import('../../apps/desktop/src/renderer/src/query/queryClient')
queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } })
const router = createHashRouter([{ path: '*', element: <QueryProvider><App /></QueryProvider> }])
window.fixtureNavigate = router.navigate
createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
