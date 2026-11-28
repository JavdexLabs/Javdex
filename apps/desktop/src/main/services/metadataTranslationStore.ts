import type { VideoScrapeTranslation } from '@shared/videoScrapeTypes'
import type Database from 'better-sqlite3'
import type { ApplyMetadataTranslation } from '@shared/metadataTranslation'
import { TRANSLATION_PAGE_SIZE, discardableTranslationStatuses, type TranslationBulkOperation, type TranslationFilmRef, type TranslationDraftRef, type TranslationFieldSelection, type TranslationFieldView, type TranslationOverview, type TranslationReviewFilter, type TranslationVideoView } from '@shared/desktop/metadataTranslationTasks'
import type { TranslationModel } from './llmTextTranslate'

export interface TranslationBatch {
  id: string
  scope: string
  libraryId: number
  libraryName: string
  model: string
  directApply: number
  createdAt: string
}

export interface TranslationItem extends TranslationFieldView {
  taskId: string
  position: number
  generation: number
  code: string
  directApply: number
}

export interface TranslationIntent {
  id: string
  taskId: string
  input: ApplyMetadataTranslation
  items: TranslationDraftRef[]
}

const activeItem = "status IN ('queued','running','review','failed','conflict','blocked','applying')"
const discardableItem = `i.status IN (${discardableTranslationStatuses.map(status => `'${status}'`).join(',')})`
const filmFields = 'i.taskId=f.taskId AND i.videoId=f.videoId'
const filmIntents = "w.taskId=f.taskId AND json_extract(w.input,'$.videoId')=f.videoId"

export function openMetadataTranslationStore(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrape_translation_requests (
      scope TEXT NOT NULL, pendingId INTEGER NOT NULL, videoId INTEGER NOT NULL, libraryId INTEGER,
      modelToken TEXT NOT NULL, directApply INTEGER NOT NULL, PRIMARY KEY(scope,pendingId), UNIQUE(scope,videoId)
    );
    CREATE TABLE IF NOT EXISTS metadata_translation_batches (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, libraryId INTEGER NOT NULL, libraryName TEXT NOT NULL,
      model TEXT NOT NULL, directApply INTEGER NOT NULL, paused INTEGER NOT NULL,
      message TEXT, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS translation_batch_scope ON metadata_translation_batches(scope, createdAt);
    CREATE TABLE IF NOT EXISTS metadata_translation_films (
      taskId TEXT NOT NULL REFERENCES metadata_translation_batches(id) ON DELETE CASCADE,
      videoId INTEGER NOT NULL, position INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
      model TEXT, message TEXT, PRIMARY KEY(taskId,videoId)
    );
    CREATE INDEX IF NOT EXISTS translation_film_page ON metadata_translation_films(taskId, position);
    CREATE TABLE IF NOT EXISTS metadata_translation_items (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES metadata_translation_batches(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, videoId INTEGER NOT NULL, generation INTEGER NOT NULL, code TEXT NOT NULL,
      field TEXT NOT NULL, status TEXT NOT NULL, message TEXT, revision INTEGER NOT NULL,
      original TEXT, translation TEXT, directApply INTEGER NOT NULL, previousStatus TEXT,
      UNIQUE(taskId, videoId, field)
    );
    CREATE INDEX IF NOT EXISTS translation_item_queue ON metadata_translation_items(taskId, status, position);
    CREATE INDEX IF NOT EXISTS translation_item_targets ON metadata_translation_items(videoId, generation, status);
    CREATE INDEX IF NOT EXISTS translation_item_page ON metadata_translation_items(taskId, position);
    CREATE TABLE IF NOT EXISTS metadata_translation_intents (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES metadata_translation_batches(id) ON DELETE CASCADE,
      input TEXT NOT NULL, items TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS translation_intent_queue ON metadata_translation_intents(taskId, state);
    CREATE INDEX IF NOT EXISTS translation_intent_film ON metadata_translation_intents(taskId,json_extract(input,'$.videoId'),state);
  `)
  db.transaction(() => {
    db.exec(`UPDATE metadata_translation_films AS f SET paused = 1, message = '应用已退出，可继续未完成的翻译'
      WHERE paused = 0 AND EXISTS (SELECT 1 FROM metadata_translation_items i
        WHERE ${filmFields} AND i.status IN ('queued','running'));
      UPDATE metadata_translation_items SET status = 'queued' WHERE status = 'running';
      UPDATE metadata_translation_intents SET state = 'uncertain' WHERE state IN ('queued','retry','sending');`)
  })()

  const getBatch = db.prepare('SELECT * FROM metadata_translation_batches WHERE id = ? AND scope = ?')
  const getItem = db.prepare('SELECT * FROM metadata_translation_items WHERE taskId = ? AND id = ?')
  const scopedItem = db.prepare('SELECT i.* FROM metadata_translation_items i JOIN metadata_translation_batches b ON b.id=i.taskId WHERE i.id=? AND b.scope=?')
  const getFilm = db.prepare(`SELECT paused,model,
    EXISTS (SELECT 1 FROM metadata_translation_items i WHERE ${filmFields} AND i.status IN ('queued','running')) AS hasWork,
    EXISTS (SELECT 1 FROM metadata_translation_intents w WHERE ${filmIntents} AND w.state='uncertain') AS uncertain
    FROM metadata_translation_films f WHERE f.taskId=? AND f.videoId=?`)
  const insertFilm = db.prepare('INSERT INTO metadata_translation_films(taskId,videoId,position) VALUES(?,?,?)')
  // Existing work databases require a value for the batch-level paused column.
  const insertBatch = db.prepare(`INSERT INTO metadata_translation_batches
    (id,scope,libraryId,libraryName,model,directApply,paused,createdAt)
    VALUES (@id,@scope,@libraryId,@libraryName,@model,@directApply,0,@createdAt)`)
  const insertItem = db.prepare(`INSERT INTO metadata_translation_items
    (id,taskId,position,videoId,generation,code,field,status,message,revision,original,translation,directApply,previousStatus)
    VALUES (@id,@taskId,@position,@videoId,@generation,@code,@field,@status,@message,@revision,@original,@translation,@directApply,@previousStatus)`)
  const updateItem = db.prepare(`UPDATE metadata_translation_items SET status=@status, message=@message,
    revision=@revision, original=@original, translation=@translation, directApply=@directApply, previousStatus=@previousStatus WHERE id=@id`)
  const nextWork = db.prepare(`SELECT i.* FROM metadata_translation_batches b JOIN metadata_translation_items i ON i.taskId=b.id
    JOIN metadata_translation_films f ON ${filmFields}
    WHERE b.scope=? AND f.paused=0 AND i.status='queued' ORDER BY b.createdAt, b.rowid, i.position LIMIT 1`)
  const nextWrite = db.prepare(`SELECT w.* FROM metadata_translation_intents w JOIN metadata_translation_batches b ON b.id=w.taskId
    WHERE b.scope=? AND w.state IN ('queued','retry') ORDER BY w.rowid LIMIT 1`)
  // Keep a ready draft accessible even while another field of the same film is generating.
  const filmGroups = `WITH filmState AS (
    SELECT f.taskId,f.videoId,f.position,f.paused,f.message,b.libraryId,b.libraryName,b.createdAt,b.directApply,b.rowid AS batchOrder,
      json_extract(COALESCE(f.model,b.model),'$.name') AS modelName,
      MAX(i.status IN ('queued','running')) AS hasWork, MAX(i.status='running') AS running,
      SUM(${discardableItem}) AS selectable,
      MAX(i.status='applying') AS applying,
      EXISTS (SELECT 1 FROM metadata_translation_intents w WHERE ${filmIntents} AND w.state='uncertain') AS uncertain
    FROM metadata_translation_batches b JOIN metadata_translation_films f ON f.taskId=b.id
    JOIN metadata_translation_items i ON ${filmFields}
    WHERE b.scope=@scope GROUP BY f.taskId,f.videoId
  ), grouped AS (
    SELECT *, CASE WHEN selectable > 0 OR uncertain THEN 'attention'
      WHEN hasWork OR applying THEN 'active' ELSE 'finished' END AS category FROM filmState
  )`
  const eligible: Record<TranslationBulkOperation, string> = {
    resume: "category='active' AND hasWork AND paused",
    pause: "category='active' AND hasWork AND NOT paused",
    'remove-active': "category='active' AND NOT applying",
    'clear-completed': "category='finished'"
  }
  const overview = db.prepare(`${filmGroups} SELECT COUNT(*) AS total,
    COUNT(*) FILTER (WHERE running OR (applying AND EXISTS (SELECT 1 FROM metadata_translation_intents w
      WHERE ${filmIntents} AND w.state='sending'))) AS running,
    COUNT(*) FILTER (WHERE category='attention') AS attention FROM grouped f`)
  const groupCounts = db.prepare(`${filmGroups} SELECT category, COUNT(*) AS count, SUM(selectable) AS selectableFields,
    COUNT(*) FILTER (WHERE ${eligible.resume}) AS resume, COUNT(*) FILTER (WHERE ${eligible.pause}) AS pause,
    COUNT(*) FILTER (WHERE ${eligible['remove-active']}) AS removable FROM grouped GROUP BY category`)
  const targetQueries = new Map(Object.entries(eligible).map(([op, condition]) => [
    op, db.prepare(`${filmGroups} SELECT taskId,videoId FROM grouped WHERE ${condition}`)
  ]))
  function bulkTargets(scope: string, operation: TranslationBulkOperation): TranslationFilmRef[] {
    return targetQueries.get(operation)!.all({ scope }) as TranslationFilmRef[]
  }
  const pageFilms = db.prepare(`${filmGroups} SELECT taskId,videoId,paused,message,libraryId,libraryName,createdAt,directApply,
    modelName,hasWork,running,uncertain FROM grouped WHERE category=@filter
    ORDER BY createdAt DESC,batchOrder DESC,position LIMIT @limit OFFSET @offset`)
  const filmPageFields = db.prepare(`SELECT i.id,i.videoId,i.revision,i.field,i.status,i.message,i.code,i.generation,
    i.original,i.translation,i.previousStatus FROM metadata_translation_items i
    WHERE i.taskId=@taskId AND i.videoId=@videoId ORDER BY i.position`)
  const setPaused = db.prepare('UPDATE metadata_translation_films SET paused=?,message=? WHERE taskId=? AND videoId=?')
  const deleteFields = db.prepare('DELETE FROM metadata_translation_items WHERE taskId=? AND videoId=?')
  const deleteFilm = db.prepare('DELETE FROM metadata_translation_films WHERE taskId=? AND videoId=?')
  const deleteEmptySubmission = db.prepare(`DELETE FROM metadata_translation_batches WHERE id=?
    AND NOT EXISTS (SELECT 1 FROM metadata_translation_films WHERE taskId=metadata_translation_batches.id)`)
  return {
    deferScrape(scope: string, pendingId: number, videoId: number, libraryId: number | undefined, settings: VideoScrapeTranslation) {
      db.prepare('INSERT OR REPLACE INTO scrape_translation_requests VALUES (?,?,?,?,?,?)')
        .run(scope, pendingId, videoId, libraryId ?? null, settings.modelToken, Number(settings.directApply))
    },
    deferredScrape(scope: string, pendingId: number, videoId: number) {
      return db.prepare('SELECT libraryId,modelToken,directApply FROM scrape_translation_requests WHERE scope=? AND pendingId=? AND videoId=?')
        .get(scope, pendingId, videoId) as { libraryId: number | null; modelToken: string; directApply: number } | undefined
    },
    forgetScrape(scope: string, pendingId: number) {
      db.prepare('DELETE FROM scrape_translation_requests WHERE scope=? AND pendingId=?').run(scope, pendingId)
    },
    transaction: <T>(work: () => T): T => db.transaction(work)(),
    batch: (scope: string, id: string) => getBatch.get(id, scope) as TranslationBatch | undefined,
    item: (taskId: string, id: string) => getItem.get(taskId, id) as TranslationItem | undefined,
    scopedItem: (scope: string, id: string) => scopedItem.get(id, scope) as TranslationItem | undefined,
    film: (taskId: string, videoId: number) => getFilm.get(taskId, videoId) as { paused: number; model: string | null; hasWork: number; uncertain: number } | undefined,
    addFilm: (taskId: string, videoId: number, position: number) => insertFilm.run(taskId, videoId, position),
    addBatch: (row: TranslationBatch) => insertBatch.run(row),
    addItem: (row: TranslationItem) => insertItem.run(row),
    save: (item: TranslationItem, patch: Partial<TranslationItem>) => updateItem.run({ ...item, ...patch }),
    pause(id: string, videoId: number, paused: boolean, message: string | null) {
      setPaused.run(Number(paused), message, id, videoId)
    },
    changeModel(id: string, videoId: number, model: TranslationModel) {
      const changed = db.prepare(`UPDATE metadata_translation_films AS f SET model=?, paused=0, message=NULL WHERE taskId=? AND videoId=?
        AND paused=1 AND EXISTS (SELECT 1 FROM metadata_translation_items i WHERE ${filmFields} AND i.status='queued')
        AND NOT EXISTS (SELECT 1 FROM metadata_translation_items i WHERE ${filmFields} AND i.status='running')`)
        .run(JSON.stringify(model), id, videoId)
      if (!changed.changes) throw new Error('请暂停影片任务并等待当前字段处理完成')
    },
    existing(scope: string, targets: number[]) {
      if (!targets.length) return []
      return db.prepare(`SELECT i.*, b.libraryId FROM metadata_translation_items i JOIN metadata_translation_batches b ON b.id=i.taskId
        WHERE b.scope=? AND ${activeItem} AND i.videoId IN (${targets.map(() => '?').join(',')})`)
        .all(scope, ...targets) as Array<TranslationItem & { libraryId: number }>
    },
    nextItem: (scope: string) => nextWork.get(scope) as TranslationItem | undefined,
    nextIntent(scope: string): (TranslationIntent & { retrying: boolean }) | undefined {
      const row = nextWrite.get(scope) as { id: string; taskId: string; input: string; items: string; state: string } | undefined
      return row && { id: row.id, taskId: row.taskId, input: JSON.parse(row.input), items: JSON.parse(row.items), retrying: row.state === 'retry' }
    },
    queue(intent: TranslationIntent) {
      db.prepare("INSERT INTO metadata_translation_intents (id, taskId, input, items, state) VALUES (?, ?, ?, ?, 'queued')")
        .run(intent.id, intent.taskId, JSON.stringify(intent.input), JSON.stringify(intent.items))
    },
    intentState(id: string, state: 'sending' | 'uncertain') {
      db.prepare('UPDATE metadata_translation_intents SET state=? WHERE id=?').run(state, id)
    },
    retryIntents(taskId: string, videoId: number) {
      db.prepare("UPDATE metadata_translation_intents SET state='retry' WHERE taskId=? AND json_extract(input,'$.videoId')=? AND state='uncertain'").run(taskId, videoId)
    },
    deleteIntent: (id: string) => db.prepare('DELETE FROM metadata_translation_intents WHERE id=?').run(id),
    overview: (scope: string) => overview.get({ scope }) as TranslationOverview,
    bulkTargets,
    bulk(scope: string, operation: TranslationBulkOperation, films: TranslationFilmRef[]) {
      db.transaction(() => {
        // Recheck eligibility on execution, without including tasks that arrived after confirmation opened.
        const requested = new Set(films.map(film => `${film.taskId}:${film.videoId}`))
        const changedBatches = new Set<string>()
        for (const { taskId, videoId } of bulkTargets(scope, operation)) {
          if (!requested.has(`${taskId}:${videoId}`)) continue
          if (operation === 'pause' || operation === 'resume') {
            setPaused.run(Number(operation === 'pause'), null, taskId, videoId)
          } else {
            deleteFields.run(taskId, videoId)
            deleteFilm.run(taskId, videoId)
            changedBatches.add(taskId)
          }
        }
        for (const taskId of changedBatches) deleteEmptySubmission.run(taskId)
      })()
    },
    page(scope: string, offset: number, filter: TranslationReviewFilter) {
      const rows = pageFilms.all({ scope, filter, limit: TRANSLATION_PAGE_SIZE, offset }) as Array<
        Pick<TranslationVideoView, 'taskId' | 'videoId' | 'modelName' | 'libraryName' | 'message' | 'createdAt'> &
        { paused: number; directApply: number; hasWork: number; running: number; uncertain: number; libraryId: number }>
      const items = rows.map(row => {
        const fields = filmPageFields.all({ taskId: row.taskId, videoId: row.videoId }) as Array<TranslationFieldView & { code: string; generation: number }>
        return { ...row, code: fields[0].code, generation: fields[0].generation,
          paused: !!row.paused, directApply: !!row.directApply, hasWork: !!row.hasWork, running: !!row.running, uncertain: !!row.uncertain,
          fields: fields.map(({ code: _code, generation: _generation, ...field }) => field) }
      })
      const groups = groupCounts.all({ scope }) as Array<{
        category: TranslationReviewFilter; count: number; selectableFields: number; resume: number; pause: number; removable: number
      }>
      const counts = { active: 0, attention: 0, finished: 0 }
      for (const row of groups) counts[row.category] = row.count
      const group = groups.find(row => row.category === filter)
      return { items, counts, total: counts[filter], selectableFields: group?.selectableFields ?? 0, bulkCounts: {
        resume: group?.resume ?? 0, pause: group?.pause ?? 0, 'remove-active': group?.removable ?? 0,
        'clear-completed': filter === 'finished' ? counts.finished : 0
      } }
    },
    selection(scope: string): TranslationFieldSelection[] {
      return db.prepare(`SELECT i.id,i.videoId,i.revision,i.status FROM metadata_translation_items i JOIN metadata_translation_batches b ON b.id=i.taskId
        WHERE b.scope=@scope AND ${discardableItem} ORDER BY b.createdAt DESC,b.rowid DESC,i.position`).all({ scope }) as TranslationFieldSelection[]
    }
  }
}
