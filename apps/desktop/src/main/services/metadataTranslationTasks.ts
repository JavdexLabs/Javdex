import type { PendingVideoScrapeResolutionResult, VideoScrapeTextReceipt, VideoScrapeTranslation } from '@shared/videoScrapeTypes'
import { METADATA_TRANSLATION_FIELDS } from '@shared/metadataTranslation'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { DIRECT_ID_BATCH_MAX, STRING_FIELD_MAX } from '@shared/protocol/limits'
import { isStructuredError } from '@shared/protocol/errors'
import { translationTextSchema, type ApplyMetadataTranslation, type MetadataTranslationOutcome, type TranslationTarget } from '@shared/metadataTranslation'
import type { TranslationBulkOperation, TranslationTaskPage, TranslationDraftRef, TranslationFieldStatus, TranslationModelView, TranslationReviewFilter, TranslationStart, TranslationStartResult, TranslationTaskCommand } from '@shared/desktop/metadataTranslationTasks'
import { discardableTranslationStatuses } from '@shared/desktop/metadataTranslationTasks'
import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { currentTranslationModel, translateWithModel, translationModelToken, TranslationModelUnavailable, type TranslationModel } from './llmTextTranslate'
import { openMetadataTranslationStore, type TranslationBatch, type TranslationIntent, type TranslationItem } from './metadataTranslationStore'

type TargetCatalog = Pick<ApplyMetadataTranslation, 'catalogId' | 'serverId'>
type TranslationCatalog = Pick<CatalogBackend, 'session' | 'capabilities' | 'onSessionChanged'> & {
  libraries: { get(input: { libraryId: number }): Promise<Pick<MediaLibrarySummary, 'id' | 'name' | 'status'> | null> }
  queries: Pick<CatalogBackend['queries'], 'getVideo'>
  videos: Pick<CatalogBackend['videos'], 'translationTargets' | 'applyTranslation'>
}
const scopeKey = (catalog: TargetCatalog): string => JSON.stringify([catalog.catalogId, catalog.serverId])
const messageOf = (error: unknown): string => error instanceof Error || isStructuredError(error) ? error.message : String(error)
const outcomes: Record<MetadataTranslationOutcome, { status: TranslationFieldStatus; message: string | null }> = {
  applied: { status: 'applied', message: null },
  conflict: { status: 'conflict', message: '原文已修改或清空，请按当前原文重译' },
  locked: { status: 'blocked', message: '影片有待确认刮削结果，请先处理刮削候选' },
  'out-of-scope': { status: 'moved', message: '影片已移出来源媒体库，或媒体库已归档' },
  missing: { status: 'missing', message: '原影片已不存在' }
}

export function createMetadataTranslationTasks(
  db: Database.Database,
  backend: TranslationCatalog,
  onApplied: () => void,
  models = { current: currentTranslationModel, translate: translateWithModel }
) {
  const store = openMetadataTranslationStore(db)
  let closed = false
  let generationWorker: Promise<void> | null = null
  let applicationWorker: Promise<void> | null = null
  let wakeGeneration = false, wakeApplication = false

  function catalog(): TargetCatalog | null {
    const { catalogId, serverId, mode } = backend.session()
    return catalogId && (mode === 'local' || serverId) ? { catalogId, serverId } : null
  }
  function currentScope(): string | null {
    const target = catalog()
    return target ? scopeKey(target) : null
  }
  function requireCatalog(): TargetCatalog {
    const target = catalog()
    if (closed || !target) throw new Error('当前资料库不可用')
    return target
  }
  function requireWritable(scope: string): void {
    if (closed || currentScope() !== scope || !backend.capabilities().editCatalog.allowed) {
      throw new Error('当前资料库无法写入，请检查连接及编辑权限')
    }
  }
  function batch(id: string): TranslationBatch {
    const found = store.batch(scopeKey(requireCatalog()), id)
    if (!found) throw new Error('当前资料库中没有这项任务')
    return found
  }
  async function modelView(): Promise<TranslationModelView> {
    const model = await models.current()
    return { name: model.name, location: model.kind === 'local' ? 'local-model' : model.local ? 'local-service' : 'cloud', token: translationModelToken(model) }
  }
  async function confirmedModel(token: string): Promise<TranslationModel> {
    const model = await models.current()
    if (translationModelToken(model) !== token) throw new Error('翻译模型设置已变化，请刷新后重新确认')
    return model
  }
  async function targets(libraryId: number, ids: number[]): Promise<Map<number, TranslationTarget>> {
    const found = new Map<number, TranslationTarget>()
    for (let offset = 0; offset < ids.length; offset += DIRECT_ID_BATCH_MAX) {
      const rows = await backend.videos.translationTargets({ libraryId, videoIds: ids.slice(offset, offset + DIRECT_ID_BATCH_MAX) })
      for (const row of rows) found.set(row.id, row)
    }
    return found
  }

  async function start(input: TranslationStart, writtenText?: VideoScrapeTextReceipt['writtenText']): Promise<TranslationStartResult> {
    const scope = scopeKey(requireCatalog())
    requireWritable(scope)
    const model = await confirmedModel(input.modelToken)
    const ids = [...new Set(input.videoIds)]
    const fields = [...new Set(input.fields)]
    const library = await backend.libraries.get({ libraryId: input.libraryId })
    if (!library || library.status !== 'active') throw new Error('来源媒体库已归档或不存在')
    const found = await targets(library.id, ids)
    requireWritable(scope)

    // A film moved to another library may start a new batch there.
    const otherLibraries = new Map<number, Set<number>>()
    for (const item of store.existing(scope, [...found.keys()])) {
      if (item.libraryId === library.id || item.generation !== found.get(item.videoId)?.generation) continue
      const videos = otherLibraries.get(item.libraryId) ?? new Set<number>()
      videos.add(item.videoId)
      otherLibraries.set(item.libraryId, videos)
    }
    const memberships = new Map<number, Map<number, TranslationTarget>>()
    for (const [libraryId, videos] of otherLibraries) memberships.set(libraryId, await targets(libraryId, [...videos]))
    requireWritable(scope)
    const result = store.transaction(() => {
      const existing = new Set<string>()
      const fieldKey = (id: number, field: string): string => `${id}:${field}`
      for (const item of store.existing(scope, [...found.keys()])) {
        if (item.generation !== found.get(item.videoId)?.generation) continue
        const previousLibrary = memberships.get(item.libraryId)
        if (previousLibrary && previousLibrary.get(item.videoId)?.generation !== item.generation) {
          if (item.status !== 'applying') store.save(item, { ...outcomes['out-of-scope'], revision: item.revision + 1 })
        } else {
          existing.add(fieldKey(item.videoId, item.field))
        }
      }
      const taskId = randomUUID()
      let position = 0, duplicates = 0
      for (const id of ids) {
        const video = found.get(id)
        if (!video) continue
        const firstPosition = position
        for (const field of fields) {
          if (existing.has(fieldKey(id, field))) { duplicates++; continue }
          if (position === 0) store.addBatch({
            id: taskId, scope, libraryId: library.id, libraryName: library.name, createdAt: new Date().toISOString(),
            model: JSON.stringify(model), directApply: Number(input.directApply)
          })
          if (position === firstPosition) store.addFilm(taskId, id, position)
          store.addItem({
            id: randomUUID(), taskId, position: position++, videoId: id, generation: video.generation, code: video.code, field,
            status: 'queued', message: null, revision: 1, original: writtenText?.[field] ?? null, translation: null, directApply: Number(input.directApply), previousStatus: null
          })
        }
      }
      return { taskId: position ? taskId : null, duplicates, unavailable: ids.length - found.size }
    })
    kick()
    return result
  }

  async function enqueueScrapedText(scope: string, videoId: number, libraryId: number | undefined,
    settings: VideoScrapeTranslation, writtenText: VideoScrapeTextReceipt['writtenText']): Promise<void> {
    requireWritable(scope)
    if (!writtenText) throw new Error('资料库未返回已写入的文本字段，可在媒体库手动发起翻译')
    const fields = METADATA_TRANSLATION_FIELDS.filter(field => typeof writtenText[field] === 'string' && writtenText[field]?.trim())
    if (!fields.length) return
    const sourceLibrary = libraryId ?? (await backend.queries.getVideo({ scope: { kind: 'all' }, videoId }))?.activeLibraryId
    if (!sourceLibrary) throw new Error('找不到影片所在的活动媒体库')
    requireWritable(scope)
    const result = await start({ ...settings, videoIds: [videoId], libraryId: sourceLibrary, fields }, writtenText)
    if (result.unavailable) throw new Error('影片已不在来源媒体库中')
  }

  const scrape = {
    scope: currentScope,
    async afterWrite(scope: string | null, videoId: number, libraryId: number | undefined, settings: VideoScrapeTranslation,
      outcome: VideoScrapeTextReceipt & { pending?: boolean; pendingScrapeId?: number; skipped?: boolean; warnings?: string[] }) {
      try {
        if (!scope) throw new Error('当前资料库不可用')
        requireWritable(scope)
        if (outcome.pending && outcome.pendingScrapeId) store.deferScrape(scope, outcome.pendingScrapeId, videoId, libraryId, settings)
        else if (!outcome.pending && !outcome.skipped) await enqueueScrapedText(scope, videoId, libraryId, settings, outcome.writtenText)
      } catch (error) {
        outcome.warnings = [...outcome.warnings ?? [], `自动翻译未启动：${messageOf(error)}`]
      }
    },
    async afterConfirm(scope: string | null, pendingId: number, originalId: number, retainedId: number, result: PendingVideoScrapeResolutionResult) {
      if (!scope || result.status === 'merge-required' || result.directorChoice) return
      const saved = store.deferredScrape(scope, pendingId, originalId)
      if (!saved) return
      store.forgetScrape(scope, pendingId)
      if (result.applied) await scrape.afterWrite(scope, retainedId, saved.libraryId ?? undefined,
        { modelToken: saved.modelToken, directApply: Boolean(saved.directApply) }, result)
    },
    discard(scope: string | null, pendingId: number) { if (scope) store.forgetScrape(scope, pendingId) }
  }

  function requireItem(taskId: string, ref: TranslationDraftRef): TranslationItem {
    const item = store.item(taskId, ref.id)
    if (!item || item.videoId !== ref.videoId || item.revision !== ref.revision) throw new Error('译文状态已变化，请重新选择')
    return item
  }

  function queueApplication(task: TranslationBatch, items: TranslationItem[]): void {
    const first = items[0]
    const input: ApplyMetadataTranslation = {
      ...requireCatalog(), libraryId: task.libraryId, videoId: first.videoId, generation: first.generation, fields: {}
    }
    const refs: TranslationDraftRef[] = []
    for (const item of items) {
      if ((item.status !== 'review' && item.status !== 'blocked') || !item.translation || item.original === null) {
        throw new Error('该译文当前无法应用，请刷新结果')
      }
      input.fields[item.field] = { original: item.original, translation: item.translation }
      const revision = item.revision + 1
      store.save(item, { status: 'applying', revision, message: null })
      refs.push({ id: item.id, revision, videoId: item.videoId })
    }
    store.queue({ id: randomUUID(), taskId: task.id, input, items: refs })
  }

  async function apply(intent: TranslationIntent & { retrying: boolean }, scope: string): Promise<void> {
    store.intentState(intent.id, 'sending')
    let applied = false
    try {
      const result = await backend.videos.applyTranslation(intent.input, { operationId: intent.id, expectedVersions: {} })
      if (closed) return
      store.transaction(() => {
        for (const ref of intent.items) {
          const item = requireItem(intent.taskId, ref)
          const outcome = result.fields[item.field]
          if (!outcome) throw new Error('写入结果缺少字段，请核对回执')
          store.save(item, { ...outcomes[outcome], revision: item.revision + 1 })
          applied ||= outcome === 'applied'
        }
        store.deleteIntent(intent.id)
      })
    } catch (error) {
      if (closed) return
      // A rejected replay does not resolve whether the original write committed.
      const definite = !intent.retrying && isStructuredError(error) && !['CONNECTION_UNAVAILABLE', 'RECOVERY_REQUIRED', 'INVALID_INPUT', 'OPERATION_KEY_REUSED'].includes(error.code)
      store.transaction(() => {
        for (const ref of intent.items) {
          const item = requireItem(intent.taskId, ref)
          store.save(item, { status: definite ? 'blocked' : 'applying', message: messageOf(error) })
        }
        if (definite) store.deleteIntent(intent.id)
        else store.intentState(intent.id, 'uncertain')
      })
    }
    if (applied && currentScope() === scope) onApplied()
  }

  async function generate(item: TranslationItem, scope: string): Promise<void> {
    const task = store.batch(scope, item.taskId)!
    store.save(item, { status: 'running', message: null })
    const stillRunning = (): boolean => !closed && store.item(item.taskId, item.id)?.status === 'running'
    const save = (patch: Partial<TranslationItem>): void => {
      if (stillRunning()) store.save(item, { revision: item.revision + 1, previousStatus: null, ...patch })
    }
    const skip = (original: string, message: string): void => {
      save(item.previousStatus
        ? { status: item.previousStatus, message }
        : { status: 'skipped', original, translation: null, message })
    }
    try {
      const video = await backend.queries.getVideo({ scope: { kind: 'library', libraryId: task.libraryId }, videoId: item.videoId })
      if (!stillRunning()) return
      requireWritable(scope)
      if (!video || video.generation !== item.generation) {
        const elsewhere = !video && await backend.queries.getVideo({ scope: { kind: 'all' }, videoId: item.videoId })
        save(elsewhere && elsewhere.generation === item.generation ? outcomes['out-of-scope'] : outcomes.missing)
        return
      }
      if (video.activeLibraryId !== task.libraryId) { save(outcomes['out-of-scope']); return }
      const original = video[item.field] ?? ''
      if (!item.previousStatus && item.original !== null && item.original !== original) {
        skip(item.original, '刮削后原文已更改，已跳过自动翻译')
        return
      }
      const text = original.trim()
      if (!text) { skip(original, '原文为空'); return }
      if (original.length > STRING_FIELD_MAX) throw new Error('原文超过资料库文本长度上限')
      const translated = translationTextSchema.parse(await models.translate(text, JSON.parse(store.film(task.id, item.videoId)?.model ?? task.model) as TranslationModel))
      if (!stillRunning()) return
      requireWritable(scope)
      if (translated === text) {
        skip(original, '译文与原文相同')
        return
      }
      store.transaction(() => {
        const draft: TranslationItem = {
          ...item, revision: item.revision + 1, status: 'review', message: null, original, translation: translated, previousStatus: null
        }
        store.save(item, draft)
        if (item.directApply) queueApplication(task, [draft])
      })
      if (item.directApply) kickApplication()
    } catch (error) {
      if (!stillRunning()) return
      if (error instanceof TranslationModelUnavailable || currentScope() !== scope || !backend.capabilities().editCatalog.allowed) {
        store.save(item, { status: 'queued' })
        store.pause(task.id, item.videoId, true, messageOf(error))
      } else {
        save({ status: item.previousStatus ?? 'failed', message: messageOf(error) })
      }
    }
  }

  async function pumpGeneration(): Promise<void> {
    while (!closed) {
      const scope = currentScope()
      if (!scope || !backend.capabilities().editCatalog.allowed) return
      const item = store.nextItem(scope)
      if (!item) return
      await generate(item, scope)
    }
  }
  async function pumpApplication(): Promise<void> {
    while (!closed) {
      const scope = currentScope()
      if (!scope || !backend.capabilities().editCatalog.allowed) return
      const intent = store.nextIntent(scope)
      if (!intent) return
      await apply(intent, scope)
    }
  }
  function kickApplication(): void {
    if (closed) return
    if (applicationWorker) { wakeApplication = true; return }
    applicationWorker = Promise.resolve().then(pumpApplication)
      .catch(error => console.error('[metadata-translation] application', error))
      .finally(() => {
        applicationWorker = null
        if (wakeApplication) { wakeApplication = false; kickApplication() }
      })
  }
  function kick(): void {
    if (closed) return
    kickApplication()
    if (generationWorker) { wakeGeneration = true; return }
    generationWorker = Promise.resolve().then(pumpGeneration)
      .catch(error => console.error('[metadata-translation] generation', error))
      .finally(() => {
        generationWorker = null
        if (wakeGeneration) { wakeGeneration = false; kick() }
      })
  }
  const unsubscribe = backend.onSessionChanged?.(kick)

  function discard(item: TranslationItem): void {
    if (!discardableTranslationStatuses.includes(item.status)) throw new Error('该字段当前无法丢弃，请重新选择')
    store.save(item, { revision: item.revision + 1, status: 'discarded', original: null, translation: null, message: null })
  }

  async function command(request: TranslationTaskCommand): Promise<TranslationDraftRef | undefined> {
    if (request.action === 'bulk') {
      const scope = scopeKey(requireCatalog())
      if (request.operation === 'resume') requireWritable(scope)
      store.bulk(scope, request.operation, request.films)
      kick()
      return
    }
    if ('items' in request) {
      const scope = scopeKey(requireCatalog())
      if (request.action === 'apply') requireWritable(scope)
      store.transaction(() => {
        const selected = new Map<string, TranslationItem>()
        for (const ref of request.items) {
          const item = selected.get(ref.id) ?? store.scopedItem(scope, ref.id)
          if (!item || item.revision !== ref.revision || item.videoId !== ref.videoId) throw new Error('译文状态已变化，请重新选择')
          selected.set(item.id, item)
        }
        if (request.action === 'discard-selected') {
          for (const item of selected.values()) discard(item)
          return
        }
        const groups = new Map<string, TranslationItem[]>()
        for (const item of selected.values()) {
          const key = `${item.taskId}:${item.videoId}`
          const group = groups.get(key)
          if (group) group.push(item)
          else groups.set(key, [item])
        }
        for (const items of groups.values()) queueApplication(batch(items[0].taskId), items)
      })
      if (request.action === 'apply') kickApplication()
      return
    }
    const task = batch(request.taskId)
    const film = 'videoId' in request ? store.film(task.id, request.videoId) : null
    if ('videoId' in request && !film) throw new Error('影片翻译任务不存在')
    switch (request.action) {
      case 'pause':
        if (!film?.hasWork || film.paused) throw new Error('该任务当前无法暂停')
        store.pause(task.id, request.videoId, true, null)
        break
      case 'continue':
        requireWritable(task.scope)
        if (!film?.hasWork || !film.paused) throw new Error('该任务当前无法继续')
        store.pause(task.id, request.videoId, false, null)
        break
      case 'retry-apply':
        requireWritable(task.scope)
        if (!film?.uncertain) throw new Error('该任务没有待核对的写入结果')
        store.retryIntents(task.id, request.videoId)
        break
      case 'change-model': {
        requireWritable(task.scope)
        const model = await confirmedModel(request.modelToken)
        requireWritable(task.scope)
        store.changeModel(task.id, request.videoId, model)
        break
      }
      default: {
        const item = requireItem(task.id, request.item)
        const editable = ['review', 'blocked', 'conflict'].includes(item.status)
        const revision = item.revision + 1
        if (request.action === 'discard') {
          discard(item)
        } else if (request.action === 'edit' && editable) {
          store.save(item, { revision, translation: request.translation, message: item.status === 'review' ? null : item.message, directApply: 0 })
          return { id: item.id, videoId: item.videoId, revision }
        } else if ((request.action === 'retry' && item.status === 'failed') || (request.action === 'retranslate' && editable)) {
          requireWritable(task.scope)
          store.save(item, {
            revision, status: 'queued', message: null, previousStatus: editable ? item.status : null,
            directApply: request.action === 'retranslate' ? 0 : item.directApply
          })
        } else {
          throw new Error('该状态下无法执行此操作')
        }
      }
    }
    kick()
  }

  async function page(offset: number, filter: TranslationReviewFilter = 'active'): Promise<TranslationTaskPage> {
    const scope = scopeKey(requireCatalog())
    const result = store.page(scope, offset, filter)
    const conflicts = new Map<number, typeof result.items>()
    for (const film of result.items) {
      if (!film.fields.some(field => field.status === 'conflict' || field.previousStatus === 'conflict')) continue
      const group = conflicts.get(film.libraryId) ?? []
      group.push(film)
      conflicts.set(film.libraryId, group)
    }
    await Promise.all([...conflicts].map(async ([libraryId, films]) => {
      const current = await backend.videos.translationTargets({
        libraryId, videoIds: [...new Set(films.map(film => film.videoId))], includeText: true
      }).catch(() => [])
      const byId = new Map(current.map(video => [video.id, video]))
      for (const film of films) {
        const source = byId.get(film.videoId)
        if (source?.generation !== film.generation) continue
        for (const field of film.fields) {
          if (field.status === 'conflict' || field.previousStatus === 'conflict') field.currentOriginal = source[field.field]
        }
      }
    }))
    if (closed || currentScope() !== scope) throw new Error('当前资料库已切换，请刷新任务')
    return { ...result, items: result.items.map(({ generation: _generation, libraryId: _libraryId, ...film }) => film) }
  }

  return {
    scrape, modelView, start: (input: TranslationStart) => start(input), command, page,
    bulkTargets: (operation: TranslationBulkOperation) => store.bulkTargets(scopeKey(requireCatalog()), operation),
    list: () => { const scope = currentScope(); return scope ? store.overview(scope) : { total: 0, running: 0, attention: 0 } },
    selection: () => store.selection(scopeKey(requireCatalog())),
    close: () => { closed = true; unsubscribe?.() }
  }
}
