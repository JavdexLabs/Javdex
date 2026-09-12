import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LibraryScanAudit, LibraryScanFileAuditEntry, LibraryScanNfoDisposition, LibraryScanResourceAuditEntry } from './libraryTypes'
import { buildScanAuditViewItems, type ScanAuditViewItemsInput, fileDetail, fileView, hasNfoPendingTarget, isAttentionFile, resourceView, type ViewItem } from './scanAuditView'

const base = { rootId: 7, filePath: 'C:\\library\\ABC-001.mp4', sourceKind: 'local' as const }
const resource = { videoId: 31, videoCode: 'ABC-001', resourceId: 42, resourceKind: 'local' as const }
const cases: Array<{
  name: string
  entry: LibraryScanFileAuditEntry
  detail: string
  videoId?: number
  groupId?: number
  attention: boolean
}> = [
  { name: 'added new video', entry: { ...base, ...resource, outcome: 'added', createdVideo: true }, detail: '新建影片并添加资源', videoId: 31, attention: false },
  { name: 'added existing video', entry: { ...base, ...resource, outcome: 'added', createdVideo: false }, detail: '挂载到已有影片', videoId: 31, attention: false },
  { name: 'updated relocated', entry: { ...base, ...resource, outcome: 'updated', updateKind: 'relocated' }, detail: '路径已重定位', videoId: 31, attention: false },
  { name: 'updated metadata', entry: { ...base, ...resource, outcome: 'updated', updateKind: 'metadata_refreshed' }, detail: '文件信息已刷新', videoId: 31, attention: false },
  { name: 'updated STRM', entry: { ...base, ...resource, sourceKind: 'strm', outcome: 'updated', updateKind: 'strm_target_synced' }, detail: 'STRM 目标已同步', videoId: 31, attention: false },
  { name: 'pending new local', entry: { ...base, outcome: 'pending', normalizedCode: 'ABC-001', groupId: 9, addedToQueue: true }, detail: 'ABC-001 · 本地文件 · 已加入待确认队列', groupId: 9, attention: false },
  { name: 'pending retained STRM', entry: { ...base, sourceKind: 'strm', outcome: 'pending', normalizedCode: null, groupId: null, addedToQueue: false }, detail: '番号未知 · STRM · 仍在待确认队列', attention: false },
  { name: 'pending empty code and zero group', entry: { ...base, outcome: 'pending', normalizedCode: '', groupId: 0, addedToQueue: false }, detail: '番号未知 · 本地文件 · 仍在待确认队列', groupId: 0, attention: false },
  { name: 'skipped unchanged with video', entry: { ...base, ...resource, outcome: 'skipped', skipReason: 'unchanged' }, detail: '未变化', videoId: 31, attention: false },
  { name: 'skipped short without video', entry: { ...base, outcome: 'skipped', skipReason: 'below_min_duration' }, detail: '低于最短时长', attention: false },
  { name: 'skipped duplicate with zero video', entry: { ...base, outcome: 'skipped', skipReason: 'duplicate', videoId: 0 }, detail: '重复资源', videoId: 0, attention: false },
  { name: 'unrecognized', entry: { ...base, outcome: 'unrecognized' }, detail: '文件名未识别出番号', attention: true },
  { name: 'STRM failure', entry: { ...base, sourceKind: 'strm', outcome: 'strm_failure', failureCode: 'read_failed', message: '读取失败 · 原始提示' }, detail: '读取失败 · 原始提示', attention: true },
  { name: 'processing failure', entry: { ...base, outcome: 'processing_failure', message: '处理失败\n第二行' }, detail: '处理失败\n第二行', attention: true }
]

describe('file scan audit presentation', () => {
  for (const testCase of cases) it(testCase.name, () => {
    const { entry, detail, videoId, groupId, attention } = testCase
    const before = structuredClone(entry)
    assert.equal(fileDetail(entry), detail)
    assert.deepEqual(fileView(entry, 13), {
      key: 'file:13:C:\\library\\ABC-001.mp4', title: 'ABC-001.mp4', detail,
      outcome: entry.outcome, path: 'C:\\library\\ABC-001.mp4', rootId: 7, videoId, groupId
    })
    assert.equal(isAttentionFile(entry), attention)
    assert.equal(hasNfoPendingTarget(entry), false)
    assert.deepEqual(entry, before)
  })

  it('preserves caller indices, path fallback and explicit undefined fields', () => {
    for (const [path, title] of [
      ['/library/ABC.mp4', 'ABC.mp4'], ['mixed\\directory/ABC.mp4', 'ABC.mp4'],
      ['/library/', '/library/'], ['bare.mp4', 'bare.mp4'], ['', '']
    ]) {
      const entry: LibraryScanFileAuditEntry = { rootId: 0, sourceKind: 'local', filePath: path, outcome: 'unrecognized' }
      assert.deepEqual(fileView(entry, 0), {
        key: `file:0:${path}`, title, detail: '文件名未识别出番号', outcome: 'unrecognized',
        path, rootId: 0, videoId: undefined, groupId: undefined
      })
      assert.equal(fileView(entry, 99).key, `file:99:${path}`)
    }
  })
})

const nfoCases: Array<[LibraryScanNfoDisposition, string, boolean]> = [
  ['imported', 'NFO 已导入', false], ['skipped', 'NFO 已跳过', false],
  ['warning', 'NFO 警告', true], ['pending-candidate', 'NFO 候选待确认', true],
  ['identity-conflict', 'NFO 身份冲突', true]
]
describe('NFO secondary presentation', () => {
  for (const [disposition, label, attention] of nfoCases) it(`${disposition}: every primary outcome, warnings and attention`, () => {
    for (const testCase of cases) {
      for (const [warnings, suffix] of [
        [undefined, ''], [[], ''], [[{ code: 'empty', message: '' }], ''],
        [[{ code: 'one', message: '第一条' }, { code: 'two', message: '第二条' }], ' · 第一条；第二条']
      ] as const) {
        const entry: LibraryScanFileAuditEntry = { ...testCase.entry, nfo: { disposition, warnings: warnings?.map(warning => ({ ...warning })) } }
        const expected = `${testCase.detail} · ${label}${suffix}`
        assert.equal(fileDetail(entry), expected)
        assert.deepEqual(fileView(entry, 4), {
          key: 'file:4:C:\\library\\ABC-001.mp4', title: 'ABC-001.mp4', detail: expected,
          outcome: entry.outcome, path: 'C:\\library\\ABC-001.mp4', rootId: 7,
          videoId: testCase.videoId, groupId: testCase.groupId
        })
        assert.equal(isAttentionFile(entry), testCase.attention || attention)
        assert.equal(hasNfoPendingTarget(entry), false)
      }
    }
  })

  it('uses only the disposition-specific non-null pending id, including zero', () => {
    for (const [disposition] of nfoCases) {
      for (const id of [undefined, 0, 73]) {
        const entry: LibraryScanFileAuditEntry = {
          ...base, outcome: 'unrecognized', nfo: { disposition, pendingIdentityId: id }
        }
        assert.equal(hasNfoPendingTarget(entry), disposition === 'identity-conflict' && id !== undefined)
        entry.nfo = { disposition, pendingScrapeId: id }
        assert.equal(hasNfoPendingTarget(entry), disposition === 'pending-candidate' && id !== undefined)
        entry.nfo = { disposition, pendingIdentityId: id, pendingScrapeId: id }
        assert.equal(hasNfoPendingTarget(entry), ['identity-conflict', 'pending-candidate'].includes(disposition) && id !== undefined)
      }
    }
    // Persisted legacy nulls retain the original != null semantics.
    for (const disposition of ['identity-conflict', 'pending-candidate'] as const) {
      const entry = JSON.parse(JSON.stringify({ ...base, outcome: 'unrecognized', nfo: {
        disposition, pendingIdentityId: null, pendingScrapeId: null
      } })) as LibraryScanFileAuditEntry
      assert.equal(hasNfoPendingTarget(entry), false)
    }
  })
})

describe('resource scan audit presentation', () => {
  const reasons: Array<[LibraryScanResourceAuditEntry['reason'], string]> = [
    ['missing', '源文件缺失'], ['removed_library_path', '媒体库路径已移除'],
    ['promoted_after_removal', '原主资源移除后提升']
  ]
  const kinds: Array<[LibraryScanResourceAuditEntry['resourceKind'], string]> = [
    ['local', 'LOCAL'], ['direct', 'DIRECT'], ['web', 'WEB'], ['magnet', 'MAGNET'], ['ed2k', 'ED2K']
  ]
  for (const [reason, label] of reasons) it(`${reason}: full fields, source/title/display fallback and kinds`, () => {
    for (const [resourceKind, kindLabel] of kinds) {
      for (const [sourcePath, displayName, display] of [
        ['/source/video.mp4', '首选显示名', '首选显示名'],
        ['/source/video.mp4', null, '/source/video.mp4'],
        ['/source/video.mp4', '', '/source/video.mp4'],
        [null, '已脱敏目标', '已脱敏目标'], [null, null, '外部目标已隐藏'],
        ['', '', '外部目标已隐藏']
      ]) {
        for (const [videoTitle, title] of [[null, 'ABC-001'], ['', 'ABC-001'], ['影片名称', 'ABC-001 · 影片名称']]) {
          const entry: LibraryScanResourceAuditEntry = {
            resourceId: 42, videoId: 31, videoCode: 'ABC-001', videoTitle,
            resourceKind, sourcePath, displayName, reason
          }
          const before = structuredClone(entry)
          assert.deepEqual(resourceView(entry, 17), {
            key: 'resource:17:42', title, detail: `${kindLabel} · ${label} · ${display}`,
            path: sourcePath ?? undefined, videoId: 31
          })
          assert.equal(resourceView(entry, 0).key, 'resource:0:42')
          assert.deepEqual(entry, before)
        }
      }
    }
  })
})

it('keeps optional enrichment fields structurally available without enriching raw views', () => {
  const view: ViewItem = {
    key: 'pending-group:9', title: '待确认', detail: '资源', groupId: 9,
    status: '待处理', requiresAttention: true, isUnrecognizedPending: false,
    pendingTarget: { domain: 'scan', id: 'identity-73' }
  }
  assert.deepEqual(view.pendingTarget, { domain: 'scan', id: 'identity-73' })
  for (const domain of ['scan', 'scrape', 'actress'] as const) {
    view.pendingTarget = { domain, id: '73' }
    assert.deepEqual(view.pendingTarget, { domain, id: '73' })
  }
})

function auditFixture(files: LibraryScanFileAuditEntry[] = []): LibraryScanAudit {
  return {
    schemaVersion: 1, libraryId: 1, runId: 'view-oracle', configRevision: 1,
    trigger: 'manual', startedAt: '', finishedAt: '', status: 'success',
    files, removedResources: [], promotedResources: [], deletedVideos: [], pendingGroups: []
  }
}
function input(overrides: Partial<ScanAuditViewItemsInput> = {}): ScanAuditViewItemsInput {
  return { audit: auditFixture(), unrecognized: [], activeTab: 'all', changesFilter: 'all', outcome: 'all', ...overrides }
}
function expectedExtra(index: number, path: string, title: string, rootId: number): ViewItem {
  return {
    key: `extra-unrec:${index}:${path}`, title, detail: '未识别番号文件', outcome: 'unrecognized',
    path, rootId, isUnrecognizedPending: true, status: '待处理', requiresAttention: true
  }
}
function expectedFile(index: number, path: string, title: string, outcome: LibraryScanFileAuditEntry['outcome'], detail: string, extra: Partial<ViewItem> = {}): ViewItem {
  return { key: `file:${index}:${path}`, title, detail, outcome, path, rootId: 7,
    videoId: undefined, groupId: undefined, ...extra }
}

describe('complete historical scan audit view items', () => {
  it('deduplicates cached paths exactly, retaining first root and order even without audit', () => {
    const unrecognized = [
      { rootId: 1, filePath: 'C:\\x\\same.mp4' }, { rootId: 99, filePath: 'C:\\x\\same.mp4' },
      { rootId: 2, filePath: 'C:/x/same.mp4' }, { rootId: 3, filePath: 'c:\\x\\same.mp4' },
      { rootId: 0, filePath: '/trailing/' }, { rootId: 4, filePath: '' }
    ]
    assert.deepEqual(buildScanAuditViewItems(input({ audit: null, unrecognized, activeTab: 'failed' })), [
      expectedExtra(0, 'C:\\x\\same.mp4', 'same.mp4', 1),
      expectedExtra(1, 'C:/x/same.mp4', 'same.mp4', 2),
      expectedExtra(2, 'c:\\x\\same.mp4', 'same.mp4', 3),
      expectedExtra(3, '/trailing/', '/trailing/', 0), expectedExtra(4, '', '', 4)
    ])
    for (const activeTab of ['all', 'added_updated', 'skipped', 'changes'] as const) {
      assert.deepEqual(buildScanAuditViewItems(input({ audit: null, unrecognized, activeTab })), [])
    }
  })

  it('orders failed extras, attention files and pending groups; excludes only attention-listed cache paths', () => {
    const audit = auditFixture([
      { ...base, ...resource, filePath: '/ok', outcome: 'added', createdVideo: true },
      { ...base, filePath: '/u', outcome: 'unrecognized' },
      { ...base, filePath: '/done', outcome: 'unrecognized' },
      { ...base, filePath: '/fail', outcome: 'processing_failure', message: '原始错误' },
      { ...base, filePath: '/warn', outcome: 'skipped', skipReason: 'unchanged', nfo: { disposition: 'warning', warnings: [{ code: 'w', message: '注意' }] } },
      { ...base, filePath: '/pending', outcome: 'pending', normalizedCode: 'P-1', groupId: 99, addedToQueue: true }
    ])
    audit.pendingGroups = [
      { groupId: 8, normalizedCode: 'B-2', resourceCount: 3 },
      { groupId: 4, normalizedCode: 'A-1', resourceCount: 1 },
      { groupId: 8, normalizedCode: 'B-2', resourceCount: 3 }
    ]
    const args = input({ audit, activeTab: 'failed', outcome: 'added', changesFilter: 'deleted', unrecognized: [
      { rootId: 1, filePath: '/extra' }, { rootId: 99, filePath: '/extra' },
      { rootId: 2, filePath: '/u' }, { rootId: 3, filePath: '/warn' }, { rootId: 4, filePath: '/ok' }
    ] })
    assert.deepEqual(buildScanAuditViewItems(args), [
      expectedExtra(0, '/extra', 'extra', 1), expectedExtra(1, '/ok', 'ok', 4),
      expectedFile(0, '/u', 'u', 'unrecognized', '文件名未识别出番号', { isUnrecognizedPending: true, status: '待处理', requiresAttention: true }),
      expectedFile(1, '/done', 'done', 'unrecognized', '文件名未识别出番号', { isUnrecognizedPending: false, status: '已处理', requiresAttention: false }),
      expectedFile(2, '/fail', 'fail', 'processing_failure', '原始错误'),
      expectedFile(3, '/warn', 'warn', 'skipped', '未变化 · NFO 警告 · 注意'),
      { key: 'pending-group:8', title: '待确认归属 · B-2', detail: '3 个扫描资源', groupId: 8, pendingTarget: { domain: 'scan', id: '8' }, status: '待处理', requiresAttention: true },
      { key: 'pending-group:4', title: '待确认归属 · A-1', detail: '1 个扫描资源', groupId: 4, pendingTarget: { domain: 'scan', id: '4' }, status: '待处理', requiresAttention: true },
      { key: 'pending-group:8', title: '待确认归属 · B-2', detail: '3 个扫描资源', groupId: 8, pendingTarget: { domain: 'scan', id: '8' }, status: '待处理', requiresAttention: true }
    ])
  })

  it('preserves all-outcome order, duplicate audit files and indices after each outcome filter', () => {
    const audit = auditFixture(cases.map(testCase => testCase.entry))
    audit.files.push(cases[0].entry)
    const expectations = cases.map(testCase => {
      const extra: Partial<ViewItem> = { videoId: testCase.videoId, groupId: testCase.groupId }
      if (testCase.entry.outcome === 'pending') {
        const pending = testCase.entry.groupId !== null
        Object.assign(extra, { status: pending ? '待处理' : '已处理', requiresAttention: pending })
        if (pending) extra.pendingTarget = { domain: 'scan', id: String(testCase.groupId) }
      }
      if (testCase.entry.outcome === 'unrecognized') Object.assign(extra, { status: '已处理', requiresAttention: false })
      return expectedFile(0, base.filePath, 'ABC-001.mp4', testCase.entry.outcome, testCase.detail, extra)
    })
    expectations.push({ ...expectations[0] })
    for (const outcome of ['all', 'added', 'updated', 'pending', 'skipped', 'unrecognized', 'strm_failure', 'processing_failure'] as const) {
      const expected = expectations.filter(row => outcome === 'all' || row.outcome === outcome)
        .map((row, index) => ({ ...row, key: `file:${index}:C:\\library\\ABC-001.mp4` }))
      assert.deepEqual(buildScanAuditViewItems(input({ audit, outcome, changesFilter: 'deleted' })), expected)
    }
    const cached = buildScanAuditViewItems(input({ audit, outcome: 'unrecognized', unrecognized: [{ rootId: 999, filePath: base.filePath }] }))
    assert.deepEqual(cached, [expectedFile(0, base.filePath, 'ABC-001.mp4', 'unrecognized', '文件名未识别出番号', { status: '待处理', requiresAttention: true })])
  })

  it('preserves NFO status precedence, historical group fields and failed/all differences', () => {
    for (const [disposition, label, field, domain, targetId] of [
      ['identity-conflict', 'NFO 身份冲突', 'pendingIdentityId', 'scan', 'identity-0'],
      ['pending-candidate', 'NFO 候选待确认', 'pendingScrapeId', 'scrape', '0']
    ] as const) {
      for (const pending of [false, true]) {
        const audit = auditFixture([
          { ...base, filePath: '/p', outcome: 'pending', normalizedCode: 'P-1', groupId: 12, addedToQueue: false,
            nfo: { disposition, ...(pending ? { [field]: 0 } : {}) } },
          { ...base, filePath: '/u', outcome: 'unrecognized',
            nfo: { disposition, ...(pending ? { [field]: 0 } : {}) } }
        ])
        for (const activeTab of ['failed', 'all'] as const) {
          const extra: Partial<ViewItem> = { status: pending ? '待处理' : '已处理', requiresAttention: pending }
          if (pending) extra.pendingTarget = { domain, id: targetId }
          assert.deepEqual(buildScanAuditViewItems(input({ audit, activeTab, unrecognized: [{ rootId: 1, filePath: '/u' }] })), [
            expectedFile(0, '/p', 'p', 'pending', `P-1 · 本地文件 · 仍在待确认队列 · ${label}`, {
              ...extra, groupId: activeTab === 'failed' || pending ? 12 : undefined
            }),
            expectedFile(1, '/u', 'u', 'unrecognized', `文件名未识别出番号 · ${label}`, {
              ...extra, ...(activeTab === 'failed' ? { isUnrecognizedPending: true } : { groupId: undefined })
            })
          ])
        }
      }
    }
  })

  it('added/updated and skipped tabs filter before indexing and do not enrich NFO status', () => {
    const audit = auditFixture(cases.map(testCase => ({ ...testCase.entry, nfo: { disposition: 'identity-conflict', pendingIdentityId: 73 } })))
    for (const activeTab of ['added_updated', 'skipped'] as const) {
      const expectedCases = cases.filter(testCase => activeTab === 'skipped'
        ? testCase.entry.outcome === 'skipped'
        : testCase.entry.outcome === 'added' || testCase.entry.outcome === 'updated')
      assert.deepEqual(buildScanAuditViewItems(input({ audit, activeTab, outcome: 'processing_failure', changesFilter: 'removed' })),
        expectedCases.map((testCase, index) => expectedFile(index, base.filePath, 'ABC-001.mp4', testCase.entry.outcome,
          `${testCase.detail} · NFO 身份冲突`, { videoId: testCase.videoId, groupId: testCase.groupId })))
    }
  })

  it('composes changes in removed/promoted/deleted order with independent indices and removed-video suppression', () => {
    const audit = auditFixture()
    audit.removedResources = [
      { resourceId: 11, videoId: 21, videoCode: 'A-1', videoTitle: '标题', resourceKind: 'local', sourcePath: '/a', displayName: null, reason: 'missing' },
      { resourceId: 12, videoId: 22, videoCode: 'B-2', videoTitle: null, resourceKind: 'web', sourcePath: null, displayName: null, reason: 'removed_library_path' }
    ]
    audit.promotedResources = [
      { resourceId: 13, videoId: 21, videoCode: 'A-1', videoTitle: '', resourceKind: 'direct', sourcePath: null, displayName: '脱敏', reason: 'promoted_after_removal' }
    ]
    audit.deletedVideos = [
      { videoId: 21, videoCode: 'A-1', videoTitle: '标题', reason: 'resource_less' },
      { videoId: 23, videoCode: 'C-3', videoTitle: null, reason: 'resource_less' }
    ]
    const removed: ViewItem[] = [
      { key: 'resource:0:11', title: 'A-1 · 标题', detail: 'LOCAL · 源文件缺失 · /a', path: '/a', videoId: undefined },
      { key: 'resource:1:12', title: 'B-2', detail: 'WEB · 媒体库路径已移除 · 外部目标已隐藏', path: undefined, videoId: 22 }
    ]
    // Preserve the old rule: only removed resources suppress deleted-video navigation.
    const promoted: ViewItem[] = [{ key: 'resource:0:13', title: 'A-1', detail: 'DIRECT · 原主资源移除后提升 · 脱敏', path: undefined, videoId: 21 }]
    const deleted: ViewItem[] = [
      { key: 'deleted:0:21', title: 'A-1 · 标题', detail: '扫描后移出的无资源成员' },
      { key: 'deleted:1:23', title: 'C-3', detail: '扫描后移出的无资源成员' }
    ]
    for (const [changesFilter, expected] of [
      ['all', [...removed, ...promoted, ...deleted]], ['removed', removed], ['promoted', promoted], ['deleted', deleted]
    ] as const) {
      assert.deepEqual(buildScanAuditViewItems(input({ audit, activeTab: 'changes', changesFilter, outcome: 'unrecognized' })), expected)
    }
  })

  it('does not mutate input or share enriched row objects between calls', () => {
    const args = input({ audit: auditFixture(cases.map(testCase => testCase.entry)), activeTab: 'failed', unrecognized: [
      { rootId: 1, filePath: '/extra' }, { rootId: 2, filePath: '/extra' }
    ] })
    const before = structuredClone(args)
    const first = buildScanAuditViewItems(args)
    const expected = structuredClone(first)
    first[0].status = 'changed by caller'
    assert.deepEqual(buildScanAuditViewItems(args), expected)
    assert.deepEqual(args, before)
  })
})
