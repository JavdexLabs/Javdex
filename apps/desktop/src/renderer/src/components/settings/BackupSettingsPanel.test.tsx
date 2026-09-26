import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { BackupJob, BackupRequest } from '@shared/protocol/backup'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let documentBeforeTest: Document
beforeEach(() => {
  documentBeforeTest = globalThis.document
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null, body: { style: { overflow: '' } } } })
})
afterEach(() => Object.defineProperty(globalThis, 'document', { configurable: true, value: documentBeforeTest }))
const removal = { digest: 'b'.repeat(64), bytes: 1024, fileCount: 2, location: '/data/backups', host: 'remote' as const, automaticBackup: false, retainedAutomaticBackup: false }

function text(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => text(child as TestRenderer.ReactTestInstance | string)).join('')
}

test('history expands in place without changing its count; polling preserves collapse and failures stay with the row', async () => {
  const previous = globalThis.window
  const originalInterval = globalThis.setInterval
  let refresh: (() => void) | undefined
  globalThis.setInterval = ((callback: () => void) => { refresh = callback; return originalInterval(() => {}, 60000) }) as typeof setInterval
  let rejectDelete: ((error: Error) => void) | undefined
  const requests: BackupRequest[] = []
  const job: BackupJob = { id: '6f859ccf-d362-4d9c-ae8c-b94cae542d62', kind: 'restore', phase: 'completed', createdAt: new Date().toISOString(), bytes: 200, transferred: 200 }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { backup: {
    async control(input: BackupRequest) {
      requests.push(input)
      if (input.action === 'previewRemoval') return { jobs: [job], removal }
      if (input.action === 'removeRecord') await new Promise((_resolve, reject) => { rejectDelete = reject })
      return { jobs: [{ ...job }] }
    }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api'); Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    const { default: styles } = await import('./BackupSettingsPanel.module.css')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!
    const wizard = () => renderer!.root.findAllByProps({ 'aria-label': '备份与恢复步骤' })
    assert.equal(wizard().length, 0)
    const rowBefore = renderer!.root.findByProps({ className: styles.record })
    const toggle = button('展开详情')
    assert.equal(toggle.props['aria-expanded'], false)
    assert.match(text(renderer!.root), /操作记录 · 1/)
    await act(async () => { toggle.props.onClick() })
    assert.equal(wizard().length, 0, 'history must not become the current task')
    assert.equal(renderer!.root.findByProps({ className: styles.record }), rowBefore)
    assert.match(text(renderer!.root), /操作记录 · 1/)
    assert.equal(button('收起详情'), toggle, 'keep the same focused button mounted')
    assert.equal(toggle.props['aria-expanded'], true)
    assert.equal(rowBefore.findByProps({ id: toggle.props['aria-controls'] }).props.hidden, false)
    await act(async () => { button('收起详情').props.onClick(); refresh!() })
    assert.equal(wizard().length, 0)
    assert.equal(toggle.props['aria-expanded'], false)
    assert.equal(rowBefore.findByProps({ id: toggle.props['aria-controls'] }).props.hidden, true)
    assert.match(text(renderer!.root), /操作记录 · 1/)
    const slots = renderer!.root.findAllByProps({ className: styles.feedback }).length
    await act(async () => { button('删除记录').props.onClick() })
    assert.equal(requests.some(input => input.action === 'removeRecord'), false)
    const dialog = renderer!.root.findByProps({ role: 'dialog' })
    assert.equal(dialog.findByType('input').props.checked, false)
    await act(async () => { dialog.findAllByType('button').find(node => text(node) === '删除记录')!.props.onClick() })
    assert.match(text(dialog), /正在处理/)
    assert.deepEqual(requests.find(input => input.action === 'removeRecord'), { action: 'removeRecord', id: job.id, deleteFiles: false })
    await act(async () => { rejectDelete!(new Error('备份请求格式无效')) })
    assert.match(text(dialog.findByProps({ role: 'alert' })), /备份请求格式无效/)
    await act(async () => { dialog.findAllByType('button').find(node => text(node) === '取消')!.props.onClick() })
    const row = renderer!.root.findByProps({ className: styles.record })
    assert.match(text(row.findByProps({ role: 'alert' })), /备份请求格式无效/)
    assert.equal(slots, 0, 'idle feedback must not reserve empty space')
    assert.equal(renderer!.root.findAllByProps({ className: styles.feedback }).length, 0, 'row errors replace the metadata line instead of adding a feedback block')
    assert.equal(Boolean(button('删除记录').props.disabled), false)
    await act(async () => { refresh!() })
    assert.match(text(row), /备份请求格式无效/)
    assert.equal(wizard().length, 0)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    globalThis.setInterval = originalInterval
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})

test('snapshot shows actual image progress, elapsed time and a stalled-progress hint', async () => {
  const previous = globalThis.window
  const job: BackupJob = { id: '6f859ccf-d362-4d9c-ae8c-b94cae542d62', kind: 'restore', phase: 'snapshot',
    createdAt: new Date(Date.now() - 120000).toISOString(), bytes: 0, transferred: 0,
    progress: { stage: 'decrypting', completed: 3, total: 10, updatedAt: new Date(Date.now() - 45000).toISOString() } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { backup: {
    async control() { return { jobs: [job] } }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api'); Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    assert.match(text(renderer!.root), /处理图片加密/)
    assert.match(text(renderer!.root), /3 \/ 10 个文件/)
    assert.match(text(renderer!.root), /已用时 2 分/)
    assert.match(text(renderer!.root), /超过 30 秒未收到新的处理进度/)
    assert.doesNotMatch(text(renderer!.root), /大小待生成|下载到本机：0/)
    assert.equal(renderer!.root.findByType('progress').props.value, 3)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})

test('missing image paths are shown before explicit confirmation and remain visible in backup history', async () => {
  const previous = globalThis.window
  const calls: BackupRequest[] = []
  const job: BackupJob = {
    id: '6f859ccf-d362-4d9c-ae8c-b94cae542d62', kind: 'backup', phase: 'awaitingImages',
    createdAt: new Date().toISOString(), bytes: 0, transferred: 0,
    missingImages: { paths: ['covers/缺失图片.png', 'samples/旧样张.jpg'], digest: 'a'.repeat(64) }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { backup: {
    async control(input: BackupRequest) {
      calls.push(input)
      if (input.action === 'confirmMissingImages') {
        job.phase = 'completed'
        job.summary = { format: 'javdex-catalog-backup', formatVersion: 1, appVersion: 'test', schemaVersion: 1,
          sourcePlatform: 'win32', sourceCatalogId: 'source', createdAt: job.createdAt, roots: [], unrootedResources: 0,
          counts: { libraries: 1, videos: 1, actresses: 0, playlists: 0, images: 0 }, missingImages: job.missingImages!.paths }
      }
      return { jobs: [{ ...job }] }
    }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api')
  Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    assert.match(text(renderer!.root), /缺少 2 张图片/)
    assert.match(text(renderer!.root), /covers\/缺失图片.png/)
    assert.equal(calls.some(call => call.action === 'confirmMissingImages'), false)
    const confirm = renderer!.root.findAllByType('button').find(node => text(node) === '确认缺失并继续备份')!
    await act(async () => { confirm.props.onClick() })
    assert.deepEqual(calls.find(call => call.action === 'confirmMissingImages'), { action: 'confirmMissingImages', id: job.id, digest: 'a'.repeat(64) })
    assert.match(text(renderer!.root), /已省略 2 张缺失图片/)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})

test('restore requires explicit directory decisions and a separate destructive confirmation', async () => {
  const previous = globalThis.window
  const previousDocument = globalThis.document
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null, body: { style: { overflow: '' } } } })
  const calls: BackupRequest[] = []
  const job: BackupJob = {
    id: '6f859ccf-d362-4d9c-ae8c-b94cae542d62', kind: 'restore', phase: 'ready',
    createdAt: new Date().toISOString(), bytes: 5000, transferred: 5000,
    summary: { format: 'javdex-catalog-backup', formatVersion: 1, appVersion: 'test', schemaVersion: 1,
      createdAt: new Date().toISOString(), sourceCatalogId: 'source', sourcePlatform: 'win32',
      counts: { libraries: 1, videos: 10, actresses: 2, playlists: 1, images: 5 }, unrootedResources: 1,
      roots: [{ id: 1, libraryId: 1, name: '媒体库', path: 'D:/视频 目录' }] }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { backup: {
    async control(input: BackupRequest) {
      calls.push(input)
      if (input.action === 'restore') job.phase = 'protecting'
      if (input.action === 'preview') job.preview = { digest: 'a'.repeat(64), targetCounts: job.summary!.counts,
        missingResources: 1, removedResources: 2, blockers: [], automaticBackupPath: '/data/backups' }
      return { jobs: [{ ...job }, { ...job, id: 'history', phase: 'completed' }] }
    }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api')
  Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!
    await act(async () => { button('继续恢复').props.onClick() })
    assert.match(text(renderer!.root.findByProps({ role: 'dialog' })), /来源备份/)
    await act(async () => { button('对应资源目录').props.onClick() })
    assert.equal(button('核对恢复影响').props.disabled, true)
    await act(async () => { button('仅保留资料').props.onClick() })
    assert.equal(button('核对恢复影响').props.disabled, true)
    await act(async () => { button('确认仅保留这些资源的资料').props.onClick() })
    assert.equal(button('核对恢复影响').props.disabled, false)
    assert.equal(calls.filter(input => input.action === 'restore').length, 0)
    await act(async () => { button('稍后继续').props.onClick() })
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0)
    await act(async () => { button('展开详情').props.onClick() })
    assert.match(text(renderer!.root.findByProps({ 'aria-label': '备份与恢复步骤' })), /备份已就绪/)
    await act(async () => { button('继续恢复').props.onClick() })
    assert.equal(button('核对恢复影响').props.disabled, false, 'viewing history preserves the wizard step and directory choices')
    await act(async () => { button('核对恢复影响').props.onClick() })
    const preview = calls.find(input => input.action === 'preview')
    assert.ok(preview?.action === 'preview' && preview.omitUnrooted)
    assert.match(text(renderer!.root), /移除 2 条本地资源关联/)
    assert.equal(calls.filter(input => input.action === 'restore').length, 0)
    assert.equal(button('备份当前资料并恢复').props.disabled, true)
    await act(async () => { renderer!.root.findByType('input').props.onChange({ target: { checked: true } }) })
    assert.equal(button('备份当前资料并恢复').props.disabled, false)
    await act(async () => { button('备份当前资料并恢复').props.onClick() })
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0)
    assert.equal(calls.filter(input => input.action === 'restore').length, 1)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})


test('cancelled records are neutral, applying is not cancellable, and the current task is not duplicated', async () => {
  const previous = globalThis.window
  const base = { createdAt: new Date().toISOString(), bytes: 0, transferred: 0 }
  const jobs: BackupJob[] = [
    { ...base, id: 'running', kind: 'restore', phase: 'applying' },
    { ...base, id: 'cancelled', kind: 'backup', phase: 'cancelled', error: '操作已取消', transferError: '操作已取消' }
  ]
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { backup: {
    async control() { return { jobs } }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api'); Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    const { default: styles } = await import('./BackupSettingsPanel.module.css')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    assert.equal(renderer!.root.findAllByProps({ className: styles.record }).length, 1)
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
    assert.equal(renderer!.root.findAllByProps({ className: styles.feedback }).length, 0)
    assert.ok(!renderer!.root.findAllByType('button').some(node => ['取消任务', '重试传输'].includes(text(node))))
    const view = renderer!.root.findAllByType('button').find(node => text(node) === '展开详情')!
    await act(async () => { view.props.onClick() })
    assert.match(text(renderer!.root), /操作已取消，原资料库保持可用/)
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
    assert.match(text(renderer!.root.findByProps({ 'aria-label': '备份与恢复步骤' })), /恢复资料/)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})


test('history paginates without duplicate tasks and a polling failure retains the last known progress', async () => {
  const previous = globalThis.window
  const originalInterval = globalThis.setInterval
  let refresh: (() => void) | undefined
  let offline = false
  globalThis.setInterval = ((callback: () => void) => { refresh = callback; return originalInterval(() => {}, 60000) }) as typeof setInterval
  const jobs: BackupJob[] = Array.from({ length: 8 }, (_, index) => ({
    id: String(index), kind: 'backup', phase: index === 0 ? 'packing' : 'completed',
    bytes: 0, transferred: 0, createdAt: new Date().toISOString(), downloading: index === 0
  }))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { backup: {
    async control() { if (offline) throw new Error('连接中断'); return { jobs } }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api'); Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    const { default: styles } = await import('./BackupSettingsPanel.module.css')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!
    assert.equal(renderer!.root.findAllByProps({ className: styles.record }).length, 5)
    assert.match(text(renderer!.root), /正在准备备份文件，生成后保存到本机/)
    assert.doesNotMatch(text(renderer!.root), /0.0 MiB|大小待生成/)
    await act(async () => { button('下一页').props.onClick() })
    assert.equal(renderer!.root.findAllByProps({ className: styles.record }).length, 2)
    offline = true
    await act(async () => { refresh!() })
    assert.match(text(renderer!.root), /尚未确认任务停止/)
    assert.match(text(renderer!.root.findByProps({ 'aria-label': '备份与恢复步骤' })), /打包备份/)
    assert.equal(renderer!.root.findAllByProps({ className: styles.record }).length, 2)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    globalThis.setInterval = originalInterval
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})


test('completed live tasks move into history once, without replacing another expanded record', async () => {
  const previous = globalThis.window
  const originalInterval = globalThis.setInterval
  let refresh: (() => void) | undefined
  globalThis.setInterval = ((callback: () => void) => { refresh = callback; return originalInterval(() => {}, 60000) }) as typeof setInterval
  let jobs: BackupJob[] = [{ id: 'live', kind: 'backup', phase: 'packing', bytes: 0, transferred: 0, createdAt: new Date().toISOString() }]
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { backup: {
    async control() { return { jobs } }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api'); Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    const { default: styles } = await import('./BackupSettingsPanel.module.css')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    jobs = [{ ...jobs[0], phase: 'completed', downloading: true, bytes: 1024 }]
    await act(async () => { refresh!() })
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': '备份与恢复步骤' }).length, 1, 'initial download remains in the task card')
    jobs = [{ ...jobs[0], downloading: false, savedPath: 'D:/备份/完成.javdex-backup' }]
    await act(async () => { refresh!() })
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': '备份与恢复步骤' }).length, 0)
    assert.match(text(renderer!.root), /操作记录 · 1/)
    assert.match(text(renderer!.root.findByProps({ className: styles.recordDetails })), /D:\/备份\/完成.javdex-backup/)
    const toggle = renderer!.root.findAllByType('button').find(node => text(node) === '收起详情')!
    await act(async () => { toggle.props.onClick(); refresh!() })
    assert.equal(toggle.props['aria-expanded'], false, 'a completed job must not reopen on polling')
    jobs = [...jobs, { ...jobs[0], id: 'older', savedPath: 'D:/备份/旧副本.javdex-backup' }]
    await act(async () => { refresh!() })
    const rows = renderer!.root.findAllByProps({ className: styles.record })
    await act(async () => { rows[0].findAllByType('button').find(node => text(node) === '展开详情')!.props.onClick() })
    await act(async () => { rows[1].findAllByType('button').find(node => text(node) === '展开详情')!.props.onClick() })
    assert.equal(rows[0].findByProps({ className: styles.recordDetails }).props.hidden, true)
    assert.equal(rows[1].findByProps({ className: styles.recordDetails }).props.hidden, false)
    assert.match(text(renderer!.root), /操作记录 · 2/)
    act(() => renderer!.unmount())
    jobs = [{ ...jobs[0], phase: 'packing' }, jobs[1]]
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const historyToggle = renderer!.root.findAllByType('button').find(node => text(node) === '展开详情')!
    await act(async () => { historyToggle.props.onClick() })
    jobs = [{ ...jobs[0], phase: 'completed' }, jobs[1]]
    await act(async () => { refresh!() })
    assert.equal(historyToggle.props['aria-expanded'], true, 'completion must not replace the historical record being read')
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': '备份与恢复步骤' }).length, 0)
    assert.match(text(renderer!.root), /操作记录 · 2/)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    globalThis.setInterval = originalInterval
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})

test('file cleanup is an explicit confirmed choice and names protective backups separately', async () => {
  const previous = globalThis.window
  let jobs: BackupJob[] = [{ id: 'remove-me', kind: 'backup', phase: 'completed', bytes: 1024, transferred: 1024, createdAt: new Date().toISOString() }]
  const calls: BackupRequest[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { backup: {
    async control(input: BackupRequest) {
      calls.push(input)
      if (input.action === 'previewRemoval') return { jobs, removal: { ...removal, automaticBackup: true } }
      if (input.action === 'removeRecord') jobs = []
      return { jobs }
    }, async file() { return { cancelled: true } }
  } } } })
  const { api } = await import('../../api'); Object.assign(api.backup, window.api.backup)
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./BackupSettingsPanel')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const button = (label: string) => renderer!.root.findAllByType('button').find(node => text(node) === label)!
    await act(async () => { button('删除记录').props.onClick() })
    const dialog = renderer!.root.findByProps({ role: 'dialog' })
    assert.match(text(dialog), /自动保护备份/)
    assert.match(text(dialog), /手动另存的副本将保留/)
    await act(async () => { dialog.findByType('input').props.onChange({ target: { checked: true } }) })
    assert.equal(calls.some(input => input.action === 'removeRecord'), false)
    await act(async () => { button('删除记录及备份').props.onClick() })
    assert.deepEqual(calls.find(input => input.action === 'removeRecord'), { action: 'removeRecord', id: 'remove-me', deleteFiles: true, digest: removal.digest })
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0)
    assert.match(text(renderer!.root), /暂无操作记录/)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})
