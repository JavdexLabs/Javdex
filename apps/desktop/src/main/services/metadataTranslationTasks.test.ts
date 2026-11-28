import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import Database from 'better-sqlite3'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import { ASSUMED_LOCAL_SESSION } from '@shared/desktop/session'
import { structuredError } from '@shared/protocol/errors'
import type { ApplyMetadataTranslationResult } from '@shared/metadataTranslation'
import { createLocalDesktopCapabilities } from '../application/desktopCapabilities'
import { createMetadataTranslationTasks } from './metadataTranslationTasks'
import type { TranslationModel } from './llmTextTranslate'

const model = { kind: 'local', name: 'Test model', ref: { model: 'qwen3', variant: 'test' } } satisfies TranslationModel

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100 && !await condition(); attempt++) await setTimeout(5)
  assert.ok(await condition(), 'background work did not reach the expected checkpoint')
}

function fixture() {
  const db = new Database(':memory:')
  const writes: string[] = []
  const receipts = new Map<string, ApplyMetadataTranslationResult>()
  const video = { id: 7, code: 'TEST-007', generation: 1, activeLibraryId: 3, title: '原文', summary: 'original summary' } as ScopedVideoDetail & { generation: number }
  const films = new Map([7, 8, 9].map(id => [id, id === 7 ? video : { ...video, id, code: `TEST-00${id}`, title: `title ${id}` }]))
  let loseReceipt = false
  const backend: Parameters<typeof createMetadataTranslationTasks>[1] = {
    session: () => ({ ...ASSUMED_LOCAL_SESSION, catalogId: 'test' }),
    capabilities: createLocalDesktopCapabilities,
    libraries: { get: async () => ({ id: 3, name: '测试库', status: 'active' }) },
    queries: { getVideo: async ({ videoId }) => films.get(videoId) ?? null },
    videos: {
      translationTargets: async ({ videoIds, includeText }) => videoIds.flatMap(id => {
        const film = films.get(id)
        return film ? [{ id, generation: film.generation, code: film.code, ...(includeText && { title: film.title, summary: film.summary }) }] : []
      }),
      applyTranslation: async (input, context) => {
        const video = films.get(input.videoId)!
        writes.push(context.operationId)
        const receipt = receipts.get(context.operationId)
        if (receipt) return receipt
        const result: ApplyMetadataTranslationResult = { fields: {} }
        for (const field of ['title', 'summary'] as const) {
          const patch = input.fields[field]
          if (!patch) continue
          if (video[field] !== patch.original) result.fields[field] = 'conflict'
          else {
            video[field] = patch.translation
            result.fields[field] = 'applied'
          }
        }
        receipts.set(context.operationId, result)
        if (loseReceipt) throw structuredError('CONNECTION_UNAVAILABLE', 'response dropped')
        return result
      }
    }
  }
  return { db, writes, receipts, video, films, backend, loseReceipt: () => { loseReceipt = true } }
}

test('queues only committed scrape text, carries the review decision across candidate confirmation and restart', async () => {
  const { db, backend, films, writes } = fixture()
  const sent: string[] = []
  const models = { current: async () => model, translate: async (text: string) => { sent.push(text); return '译 ' + text } }
  let tasks = createMetadataTranslationTasks(db, backend, () => {}, models)
  try {
    const scope = tasks.scrape.scope()!
    const settings = { modelToken: (await tasks.modelView()).token, directApply: false }
    await tasks.scrape.afterWrite(scope, 7, undefined, settings, { pending: true, skipped: true, pendingScrapeId: 21 })
    await tasks.scrape.afterWrite(scope, 8, 3, settings, { pending: true, pendingScrapeId: 22 })
    tasks.scrape.discard(scope, 22)
    await tasks.scrape.afterConfirm(scope, 21, 7, 7, { status: 'merge-required', applied: false, warnings: [] })
    assert.equal(tasks.list().total, 0)
    tasks.close()
    tasks = createMetadataTranslationTasks(db, backend, () => {}, models)
    const confirmed = { status: 'applied' as const, applied: true, warnings: [], writtenText: { summary: 'original summary' } }
    await tasks.scrape.afterConfirm(scope, 22, 8, 8, confirmed)
    assert.equal(tasks.list().total, 0)
    await tasks.scrape.afterConfirm(scope, 21, 7, 8, confirmed)
    await waitFor(() => tasks.selection().length === 1)
    assert.equal(tasks.selection()[0].videoId, 8)
    assert.deepEqual(sent, ['original summary'])
    assert.equal(writes.length, 0)
    const direct = { ...settings, directApply: true }
    await tasks.scrape.afterWrite(scope, 9, 3, direct, { writtenText: { title: 'title 9', summary: 'stale text' } })
    await waitFor(() => writes.length === 1 && tasks.list().running === 0)
    assert.equal(films.get(9)?.title, '译 title 9')
    assert.deepEqual(sent, ['original summary', 'title 9'])
    const legacy = { warnings: [] as string[] }
    await tasks.scrape.afterWrite(scope, 7, 3, direct, legacy)
    assert.match(legacy.warnings.join(''), /自动翻译未启动/)
  } finally {
    tasks.close()
    db.close()
  }
})

test('approves only selected draft revisions during generation, deduplicates, and resumes remaining fields after restart', async () => {
  const { db, video, backend, writes } = fixture()
  let release!: (value: string) => void
  const pending = new Promise<string>(resolve => { release = resolve })
  const service = createMetadataTranslationTasks(db, backend, () => {}, {
    current: async () => model, translate: async text => text === '原文' ? '翻译标题' : pending
  })
  const modelToken = (await service.modelView()).token
  const input = { libraryId: 3, videoIds: [7], fields: ['title', 'summary'] as ['title', 'summary'], directApply: false, modelToken }
  const { taskId } = await service.start(input)
  assert.ok(taskId)
  await waitFor(async () => (await service.page(0, 'attention')).items[0]?.fields.some(field => field.status === 'running') === true)
  assert.equal(video.title, '原文')
  assert.deepEqual(await service.start(input), { taskId: null, duplicates: 2, unavailable: 0 })
  let selection = service.selection()
  assert.equal(selection.length, 1)
  const edited = await service.command({ action: 'edit', taskId, item: selection[0], translation: '手动修订' })
  assert.deepEqual(edited, { id: selection[0].id, videoId: 7, revision: selection[0].revision + 1 })
  assert.equal(video.title, '原文')
  await assert.rejects(service.command({ action: 'apply', items: selection }), /状态已变化/)
  selection = service.selection()
  await service.command({ action: 'apply', items: selection })
  await waitFor(async () => (await service.page(0)).items[0]?.fields[0].status === 'applied')
  assert.equal(video.title, '手动修订')
  assert.equal(video.summary, 'original summary')
  service.close()
  release('应由新进程继续')
  const restored = createMetadataTranslationTasks(db, backend, () => {}, {
    current: async () => ({ kind: 'service', name: 'New default', ref: 'cloud', fingerprint: 'changed', local: false }),
    translate: async (_text, selected) => {
      assert.deepEqual(selected, model, 'resuming keeps the confirmed model after the default changes')
      return '简介译文'
    }
  })
  assert.equal((await restored.page(0)).items[0].paused, true)
  assert.equal((await restored.page(0)).items[0].fields[1].status, 'queued')
  await restored.command({ action: 'continue', taskId, videoId: 7 })
  await waitFor(async () => restored.selection().length === 1)
  assert.equal((await restored.page(0, 'attention')).items[0].fields[1].translation, '简介译文')
  assert.equal(writes.length, 1)
  restored.close()
  db.close()
})

test('shows the current conflicting source and retains the old draft while one field is retranslated', async () => {
  const { db, video, backend, writes } = fixture()
  let resolveRetry!: (value: string) => void
  let rejectRetry!: (error: Error) => void
  let attempt: Promise<string> | undefined
  const service = createMetadataTranslationTasks(db, backend, () => {}, {
    current: async () => model,
    translate: async text => text === '当前标题' ? attempt! : `译文 ${text}`
  })
  try {
    const { taskId } = await service.start({
      libraryId: 3, videoIds: [7], fields: ['title', 'summary'], directApply: false,
      modelToken: (await service.modelView()).token
    })
    assert.ok(taskId)
    await waitFor(async () => service.selection().length === 2)
    const [title, summary] = service.selection()
    video.title = '当前标题'
    await service.command({ action: 'apply', items: [title] })
    await waitFor(async () => (await service.page(0, 'attention')).items[0]?.fields[0].status === 'conflict')
    const readConflict = async () => (await service.page(0, 'attention')).items[0].fields[0]
    let conflict = await readConflict()
    assert.equal(conflict.original, '原文')
    assert.equal(conflict.currentOriginal, '当前标题')
    assert.equal(conflict.translation, '译文 原文')
    const ref = ({ id, videoId, revision }: typeof conflict) => ({ id, videoId, revision })

    attempt = new Promise((_, reject) => { rejectRetry = reject })
    await service.command({ action: 'retranslate', taskId, item: ref(conflict) })
    await waitFor(async () => (await readConflict()).status === 'running')
    conflict = await readConflict()
    assert.equal(conflict.status, 'running')
    assert.equal(conflict.currentOriginal, '当前标题')
    assert.equal(conflict.translation, '译文 原文')
    assert.deepEqual(service.selection(), [summary])
    rejectRetry(new Error('模型连接失败'))
    await waitFor(async () => (await service.page(0, 'attention')).items[0]?.fields[0].status === 'conflict')
    conflict = await readConflict()
    assert.equal(conflict.translation, '译文 原文')
    assert.equal(conflict.message, '模型连接失败')

    attempt = new Promise(resolve => { resolveRetry = resolve })
    await service.command({ action: 'retranslate', taskId, item: ref(conflict) })
    resolveRetry('当前标题译文')
    await waitFor(async () => service.selection().length === 2)
    const page = await service.page(0, 'attention')
    assert.equal(page.items[0].fields[0].original, '当前标题')
    assert.equal(page.items[0].fields[0].translation, '当前标题译文')
    assert.deepEqual(service.selection()[1], summary)
    assert.equal(writes.length, 1)
    assert.equal(video.title, '当前标题')
  } finally {
    service.close()
    db.close()
  }
})

test('direct apply journals the write and recovers a lost remote response with the same operation ID', async () => {
  const { db, video, backend, writes, receipts, loseReceipt } = fixture()
  const models = { current: async () => model, translate: async () => '直接应用的标题' }
  loseReceipt()
  const apply = backend.videos.applyTranslation
  let send!: () => void
  const held = new Promise<void>(resolve => { send = resolve })
  backend.videos.applyTranslation = async (...args) => { await held; return apply(...args) }
  const service = createMetadataTranslationTasks(db, backend, () => {}, models)
  const { taskId } = await service.start({ libraryId: 3, videoIds: [7], fields: ['title'], directApply: true,
    modelToken: (await service.modelView()).token })
  assert.ok(taskId)
  await waitFor(async () => (await service.page(0, 'active')).items[0]?.fields[0].status === 'applying')
  assert.deepEqual(service.bulkTargets('remove-active'), [])
  await service.command({ action: 'bulk', operation: 'remove-active', films: [{ taskId, videoId: 7 }] })
  assert.equal((await service.page(0, 'active')).total, 1)
  send()
  await waitFor(async () => (await service.page(0, 'attention')).items[0]?.uncertain === true)
  assert.equal(video.title, '直接应用的标题')
  await service.command({ action: 'bulk', operation: 'remove-active', films: [{ taskId, videoId: 7 }] })
  assert.equal((await service.page(0, 'attention')).total, 1, 'uncertain writes survive removal')
  service.close()
  const restored = createMetadataTranslationTasks(db, backend, () => {}, models)
  backend.videos.applyTranslation = async () => { throw structuredError('WRITER_REVOKED', 'replay denied before receipt lookup') }
  await restored.command({ action: 'retry-apply', taskId, videoId: 7 })
  await waitFor(async () => (await restored.page(0, 'attention')).items[0]?.fields[0].message === 'replay denied before receipt lookup')
  assert.equal((await restored.page(0, 'attention')).items[0].uncertain, true)
  backend.videos.applyTranslation = apply
  await restored.command({ action: 'retry-apply', taskId, videoId: 7 })
  await waitFor(async () => (await restored.page(0, 'finished')).total === 1)
  assert.deepEqual(writes, [writes[0], writes[0]])
  assert.equal(receipts.size, 1)
  assert.equal((await restored.page(0, 'finished')).items[0].uncertain, false)
  restored.close()
  db.close()
})

test('pauses one film, runs its siblings and applies exact revisions across submissions atomically', async () => {
  const { db, backend, films, writes } = fixture()
  let release!: (text: string) => void
  const inFlight = new Promise<string>(resolve => { release = resolve })
  const service = createMetadataTranslationTasks(db, backend, () => {}, {
    current: async () => model, translate: async text => text === '原文' ? inFlight : '译 ' + text
  })
  try {
    const input = { libraryId: 3, fields: ['title', 'summary'] as ['title', 'summary'], directApply: false, modelToken: (await service.modelView()).token }
    const { taskId } = await service.start({ ...input, videoIds: [7, 8] })
    assert.ok(taskId)
    await waitFor(() => service.list().running === 1)
    await service.command({ action: 'pause', taskId, videoId: 7 })
    release('第一部标题')
    await waitFor(() => service.selection().length === 3)
    const page = await service.page(0, 'attention')
    assert.deepEqual(page.items.map(film => [film.videoId, film.paused, film.fields.map(f => f.status)]),
      [[7, true, ['review', 'queued']], [8, false, ['review', 'review']]])
    const second = await service.start({ ...input, videoIds: [9], fields: ['title'] })
    assert.ok(second.taskId)
    await waitFor(() => service.selection().length === 4)
    assert.deepEqual(service.list(), { total: 3, running: 0, attention: 3 })
    assert.deepEqual((await service.page(0, 'attention')).items.map(film => film.taskId), [second.taskId, taskId, taskId])
    const selection = service.selection()
    const other = selection.find(ref => ref.videoId === 9)!
    const title = selection.find(ref => ref.videoId === 7)!
    const edited = await service.command({ action: 'edit', taskId, item: title, translation: '手改标题' })
    assert.ok(edited)
    await assert.rejects(service.command({ action: 'apply', items: [other, title] }), /状态已变化/)
    assert.deepEqual(writes, [])
    await service.command({ action: 'apply', items: [other, edited] })
    await waitFor(async () => (await service.page(0)).counts.finished === 1 && (await service.page(0)).items[0]?.fields[0].status === 'applied')
    assert.equal(films.get(7)?.title, '手改标题')
    assert.equal(films.get(9)?.title, '译 title 9')
    assert.equal(films.get(8)?.title, 'title 8')
    await service.command({ action: 'continue', taskId, videoId: 7 })
    await waitFor(async () => service.selection().length === 3)
    assert.equal(writes.length, 2)
  } finally { service.close(); db.close() }
})

test('restores edited drafts, unfinished fields and outstanding write receipts across a restart', async () => {
  const { db, backend, writes, receipts, loseReceipt } = fixture()
  const models = { current: async () => model, translate: async (text: string) => '译 ' + text }
  let finish!: (value: string) => void
  const held = new Promise<string>(resolve => { finish = resolve })
  let summaries = 0
  const old = createMetadataTranslationTasks(db, backend, () => {}, {
    ...models, translate: async text => text === 'original summary' && ++summaries === 2 ? held : models.translate(text)
  })
  const { taskId } = await old.start({ libraryId: 3, videoIds: [7, 8], fields: ['title','summary'], directApply: false,
    modelToken: (await old.modelView()).token })
  assert.ok(taskId)
  await waitFor(() => summaries === 2 && old.selection().length === 3)
  const [titleA, summaryA, titleB] = old.selection()
  const edit = await old.command({ action: 'edit', taskId, item: summaryA, translation: '已校对的简介' })
  loseReceipt()
  await old.command({ action: 'apply', items: [titleA, titleB] })
  await waitFor(async () => (await old.page(0, 'attention')).items.filter(film => film.uncertain).length === 2)
  old.close()
  finish('进程关闭后的译文')
  const restored = createMetadataTranslationTasks(db, backend, () => {}, models)
  try {
    const films = (await restored.page(0, 'attention')).items
    assert.deepEqual(films.map(f => [f.videoId, f.paused, f.uncertain]), [[7,false,true],[8,true,true]])
    assert.equal(films[1].message, '应用已退出，可继续未完成的翻译')
    assert.equal(films[1].fields[1].status, 'queued')
    assert.ok(edit)
    assert.deepEqual(restored.selection(), [{ ...edit, status: 'review' }])
    assert.equal(films[0].fields[1].translation, '已校对的简介')
    await restored.command({ action: 'retry-apply', taskId, videoId: 7 })
    await waitFor(async () => !(await restored.page(0, 'attention')).items[0].uncertain)
    assert.equal((await restored.page(0, 'attention')).items[1].uncertain, true)
    assert.deepEqual(writes, [writes[0], writes[1], writes[0]])
    await restored.command({ action: 'continue', taskId, videoId: 8 })
    await waitFor(async () => restored.selection().length === 2)
    assert.equal(receipts.size, 2)
  } finally { restored.close(); db.close() }
})

test('bulk controls span pages and recheck each film before removal', async () => {
  const { db, backend, films, video } = fixture()
  let finish!: (text: string) => void
  const held = new Promise<string>(resolve => { finish = resolve })
  const service = createMetadataTranslationTasks(db, backend, () => {}, {
    current: async () => model, translate: async text => text === video.title ? held : '译 ' + text
  })
  try {
    const ids = Array.from({ length: 22 }, (_, i) => i + 10)
    for (const id of ids) films.set(id, { ...video, id, code: String(id), title: String(id) })
    const input = { libraryId: 3, fields: ['title'] as ['title'], directApply: false, modelToken: (await service.modelView()).token }
    const { taskId } = await service.start({ ...input, videoIds: [7, ...ids] })
    assert.ok(taskId)
    await waitFor(() => service.list().running === 1)
    const page = await service.page(20, 'active')
    assert.deepEqual(page.counts, { active: 23, attention: 0, finished: 0 })
    assert.equal(page.items.length, 3)
    assert.equal(page.bulkCounts.pause, 23)
    await service.command({ action: 'bulk', operation: 'pause', films: service.bulkTargets('pause') })
    const paused = service.bulkTargets('resume')
    assert.equal(paused.length, 23)
    await service.command({ action: 'bulk', operation: 'resume', films: paused })
    assert.equal(service.bulkTargets('pause').length, 23)
    await service.command({ action: 'bulk', operation: 'pause', films: paused })
    const snapshot = service.bulkTargets('remove-active')
    const later = await service.start({ ...input, videoIds: [8] })
    assert.ok(later.taskId)
    await service.command({ action: 'pause', taskId: later.taskId, videoId: 8 })
    finish('新译稿')
    await waitFor(() => service.selection().length === 1)
    await service.command({ action: 'bulk', operation: 'remove-active', films: snapshot })
    assert.deepEqual((await service.page(0)).counts, { active: 1, attention: 1, finished: 0 })
    assert.deepEqual(service.bulkTargets('resume'), [{ taskId: later.taskId, videoId: 8 }])
    assert.equal(service.selection().length, 1, 'draft arriving during confirmation is preserved')
    await service.command({ action: 'apply', items: service.selection() })
    await waitFor(async () => (await service.page(0, 'finished')).total === 1)
    await service.command({ action: 'bulk', operation: 'clear-completed', films: service.bulkTargets('clear-completed') })
    assert.equal(video.title, '新译稿')
    assert.deepEqual((await service.page(0)).counts, { active: 1, attention: 0, finished: 0 })
  } finally { service.close(); db.close() }
})

test('discards selected field revisions across submissions atomically while preserving catalog values and sibling drafts', async () => {
  const { db, backend, video, writes } = fixture()
  const service = createMetadataTranslationTasks(db, backend, () => {}, {
    current: async () => model, translate: async text => {
      if (text === 'title 8') throw new Error('翻译失败')
      return '译 ' + text
    }
  })
  try {
    const input = { libraryId: 3, directApply: false, modelToken: (await service.modelView()).token }
    const first = await service.start({ ...input, videoIds: [7], fields: ['title', 'summary'] })
    const second = await service.start({ ...input, videoIds: [8], fields: ['title'] })
    assert.ok(first.taskId && second.taskId)
    await waitFor(() => service.selection().length === 3)
    const selection = service.selection()
    const [title, summary] = selection.filter(ref => ref.videoId === 7)
    const failed = selection.find(ref => ref.videoId === 8)!
    assert.equal(failed.status, 'failed')
    const edit = await service.command({ action: 'edit', taskId: first.taskId, item: title, translation: '已修订' })
    assert.ok(edit)
    await assert.rejects(service.command({ action: 'discard-selected', items: [failed, title] }), /状态已变化/)
    assert.deepEqual(service.selection().filter(ref => ref.videoId === 8), [failed])
    await service.command({ action: 'discard-selected', items: [failed, edit] })
    assert.deepEqual(service.selection(), [summary])
    const result = await service.page(0, 'attention')
    assert.equal(result.selectableFields, 1)
    assert.deepEqual(result.items[0].fields.map(f => [f.status, f.translation]), [['discarded', null], ['review', '译 original summary']])
    const terminal = (await service.page(0, 'finished')).items[0].fields[0]
    await assert.rejects(service.command({ action: 'discard-selected', items: [summary, terminal] }), /无法丢弃/)
    assert.deepEqual(service.selection(), [summary], 'terminal field rolls back the preceding discard')
    assert.equal(video.title, '原文')
    assert.deepEqual(writes, [])
  } finally { service.close(); db.close() }
})
