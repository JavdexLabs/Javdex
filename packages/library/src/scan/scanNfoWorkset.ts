import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import type { LocalNfoAnchor, LocalNfoIdentityInspection } from '@library/nfo/localNfoTypes'
import type { DirectoryVideoIdentitySummary } from '@library/nfo/directoryVideoIdentity'

export interface ScanNfoPreflight {
  anchor: LocalNfoAnchor
  filenameCode: string | null
  nfoCode: string | null
  effectiveCode: string | null
  identityConflict: boolean
  inspection: LocalNfoIdentityInspection
}
export interface ScanNfoVideoBatch { code: string; anchors: LocalNfoAnchor[] }
export interface ScanNfoWorkset {
  setSidecars(dir: string, map: ReadonlyMap<string, string>): void
  hasSidecars(dir: string): boolean
  getSidecars(dir: string): ReadonlyMap<string, string> | undefined
  getDirectoryIdentity(dir: string): DirectoryVideoIdentitySummary | undefined
  setDirectoryIdentity(dir: string, summary: DirectoryVideoIdentitySummary): void
  sealDirectories(): void
  setPreflight(path: string, value: ScanNfoPreflight): void
  getPreflight(path: string): ScanNfoPreflight | undefined
  getEffectiveCode(path: string): { effectiveCode: string | null } | undefined
  sealPreflights(): void
  enqueue(videoId: number, code: string, filePath: string): void
  sealQueue(): void
  batches(): Iterable<[number, ScanNfoVideoBatch]>
  dispose(): void
}
export class ScanNfoWorksetError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Scan NFO workset failed', { cause })
    this.name = 'ScanNfoWorksetError'
  }
}
export const SCAN_NFO_WORKSET_MAX_BYTES = 1024 * 1024
function checked<T>(fn: () => T): T {
  try { return fn() } catch (error) {
    if (error instanceof ScanNfoWorksetError) throw error
    throw new ScanNfoWorksetError(error)
  }
}
function json(value: unknown): string {
  if (typeof value === 'string' && value.length > SCAN_NFO_WORKSET_MAX_BYTES) throw new Error('NFO workset record exceeds 1 MiB')
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > SCAN_NFO_WORKSET_MAX_BYTES) throw new Error('NFO workset record exceeds 1 MiB')
  return encoded
}
function budget(...values: string[]): void {
  if (values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > SCAN_NFO_WORKSET_MAX_BYTES) throw new Error('NFO workset record exceeds 1 MiB')
}
interface Directory { sidecars?: string; identity?: string }
interface PreflightRow { body: string; effective: string }
interface VideoRow { ordinal: number; videoId: number; code: string }
interface QueueRow { ordinal: number; body: string }
interface Storage {
  transaction<T>(fn: () => T): T
  outside(): void
  open(): void
  directory(key: string): Directory | undefined
  sidecars(key: string, snapshot: string): void
  identity(key: string, body: string): void
  pair(snapshot: string, ordinal: number, key: string, value: string): void
  pairGet(snapshot: string, key: string): string | undefined
  pairNext(snapshot: string, ordinal: number): { ordinal: number; key: string; value: string } | undefined
  pairCount(snapshot: string): number
  preflight(key: string, row: PreflightRow): void
  preflightGet(key: string): PreflightRow | undefined
  effective(key: string): string | undefined
  enqueue(videoId: number, code: string, key: string): void
  videoNext(ordinal: number): VideoRow | undefined
  queueNext(videoId: number, ordinal: number): QueueRow | undefined
  dispose(): void
}

function workset(storage: Storage, roots: readonly Readonly<MediaLibraryRoot>[], materializeSidecarMaps = false): ScanNfoWorkset {
  const snapshots = new Map<number, Readonly<MediaLibraryRoot>>()
  for (const root of roots) {
    if (!Number.isSafeInteger(root.id) || root.id <= 0 || snapshots.has(root.id)) throw new Error('Invalid NFO workset root')
    snapshots.set(root.id, Object.isFrozen(root) ? root : Object.freeze({ ...root }))
  }
  let state: 'directories' | 'preflights' | 'queue' | 'sealed' | 'closing' | 'disposed' = 'directories'
  const open = () => {
    if (state === 'closing' || state === 'disposed') throw new Error('NFO workset is closed')
    storage.open()
  }
  const mutate = (expected: typeof state) => {
    open(); storage.outside()
    if (state !== expected) throw new Error(`NFO workset must be ${expected}`)
  }
  // Weak keys do not retain wrappers or directory contexts across the complete scan.
  const mapSnapshots = new WeakMap<ReadonlyMap<string, string>, string>()
  let lastMap: { snapshot: string; value: ReadonlyMap<string, string> } | undefined
  let lastIdentity: { dir: string; body: string; value: LocalNfoAnchor['directoryVideoCodes'] } | undefined
  const identityFor = (dir: string, body: string): LocalNfoAnchor['directoryVideoCodes'] => {
    if (lastIdentity?.dir === dir && lastIdentity.body === body) return lastIdentity.value
    const value = Object.freeze(JSON.parse(body)) as LocalNfoAnchor['directoryVideoCodes']
    lastIdentity = { dir, body, value }
    return value
  }
  const mapFor = (snapshot: string): ReadonlyMap<string, string> => {
    if (lastMap?.snapshot === snapshot) return lastMap.value
    const entries = function* (): MapIterator<[string, string]> {
      let after = 0
      while (true) {
        const row = checked(() => { open(); return storage.pairNext(snapshot, after) })
        if (!row) return
        after = row.ordinal
        yield checked(() => [JSON.parse(row.key), JSON.parse(row.value)] as [string, string])
      }
    }
    if (materializeSidecarMaps) {
      // Detailed callers historically retain anchors after the scan has returned.
      const value = new Map(entries())
      mapSnapshots.set(value, snapshot)
      lastMap = { snapshot, value }
      return value
    }
    const result: ReadonlyMap<string, string> = {
      get size() { return checked(() => { open(); return storage.pairCount(snapshot) }) },
      get(key) { return checked(() => { open(); const value = storage.pairGet(snapshot, json(key)); return value === undefined ? undefined : JSON.parse(value) }) },
      has(key) { return checked(() => { open(); return storage.pairGet(snapshot, json(key)) !== undefined }) },
      entries,
      *keys(): MapIterator<string> { for (const [key] of entries()) yield key },
      *values(): MapIterator<string> { for (const [, value] of entries()) yield value },
      [Symbol.iterator]: entries,
      forEach(callback, thisArg) { checked(() => { for (const [key, value] of entries()) callback.call(thisArg, value, key, result) }) }
    }
    mapSnapshots.set(result, snapshot)
    lastMap = { snapshot, value: Object.freeze(result) }
    return lastMap.value
  }
  type Body = Omit<ScanNfoPreflight, 'anchor'> & {
    anchor: { rootId: number; anchorPath: string; directoryVideoCodes: LocalNfoAnchor['directoryVideoCodes']; sidecars?: string }
  }
  const hydrate = (body: string): ScanNfoPreflight => {
    const value = JSON.parse(body) as Body
    const root = snapshots.get(value.anchor.rootId)
    if (!root) throw new Error('Unknown NFO workset root')
    return { ...value, anchor: { root, anchorPath: value.anchor.anchorPath,
      directoryVideoCodes: identityFor(path.dirname(value.anchor.anchorPath), JSON.stringify(value.anchor.directoryVideoCodes)),
      ...(value.anchor.sidecars === undefined ? {} : { directorySidecars: mapFor(value.anchor.sidecars) }) } }
  }
  return {
    setSidecars(dir, map) { checked(() => {
      mutate('directories')
      const key = json(dir), snapshot = randomUUID()
      storage.transaction(() => {
        let ordinal = 0
        for (const [name, value] of map) {
          const encodedKey = json(name), encodedValue = json(value)
          budget(encodedKey, encodedValue)
          storage.pair(snapshot, ++ordinal, encodedKey, encodedValue)
        }
        storage.sidecars(key, snapshot)
      })
    }) },
    hasSidecars(dir) { return checked(() => { open(); return storage.directory(json(dir))?.sidecars !== undefined }) },
    getSidecars(dir) { return checked(() => {
      open(); const snapshot = storage.directory(json(dir))?.sidecars
      return snapshot === undefined ? undefined : mapFor(snapshot)
    }) },
    getDirectoryIdentity(dir) { return checked(() => {
      open(); const identity = storage.directory(json(dir))?.identity
      return identity === undefined ? undefined : identityFor(dir, identity) as DirectoryVideoIdentitySummary
    }) },
    setDirectoryIdentity(dir, summary) { checked(() => {
      mutate('directories'); const key = json(dir), body = json(summary); budget(key, body)
      storage.transaction(() => storage.identity(key, body))
    }) },
    sealDirectories() { checked(() => { mutate('directories'); state = 'preflights' }) },
    setPreflight(path, value) { checked(() => {
      mutate('preflights')
      if (value.inspection.status === 'missing') return
      if (!snapshots.has(value.anchor.root.id)) throw new Error('Unknown NFO workset root')
      const sidecars = value.anchor.directorySidecars === undefined ? undefined : mapSnapshots.get(value.anchor.directorySidecars)
      if (value.anchor.directorySidecars !== undefined && sidecars === undefined) throw new Error('NFO sidecars must belong to this workset')
      const body = json({ ...value, anchor: { rootId: value.anchor.root.id, anchorPath: value.anchor.anchorPath,
        directoryVideoCodes: value.anchor.directoryVideoCodes, ...(sidecars === undefined ? {} : { sidecars }) } })
      const key = json(path), effective = json(value.effectiveCode)
      budget(key, body, effective)
      storage.transaction(() => storage.preflight(key, { body, effective }))
    }) },
    getPreflight(path) { return checked(() => { open(); const row = storage.preflightGet(json(path)); return row && hydrate(row.body) }) },
    getEffectiveCode(path) { return checked(() => {
      open(); const value = storage.effective(json(path)); return value === undefined ? undefined : { effectiveCode: JSON.parse(value) }
    }) },
    sealPreflights() { checked(() => { mutate('preflights'); state = 'queue' }) },
    enqueue(videoId, code, filePath) { checked(() => {
      // Deliberate exception: summary enqueue shares the file's business transaction.
      // Ordinals and first-code selection are DB-owned, so outer rollback is complete.
      open(); if (state !== 'queue') throw new Error('NFO workset must be queue')
      if (!Number.isSafeInteger(videoId) || videoId <= 0) throw new Error('Invalid NFO video id')
      const key = json(filePath), encodedCode = json(code); budget(key, encodedCode)
      const row = storage.preflightGet(key)
      if (!row) return
      const value = JSON.parse(row.body) as Body
      if (value.identityConflict || value.inspection.status !== 'found') return
      storage.transaction(() => storage.enqueue(videoId, encodedCode, key))
    }) },
    sealQueue() { checked(() => { mutate('queue'); state = 'sealed' }) },
    batches() { return checked(() => {
      open(); if (state !== 'sealed') throw new Error('NFO queue must be sealed')
      return { *[Symbol.iterator]() {
        let after = 0
        while (true) {
          const video = checked(() => { open(); return storage.videoNext(after) })
          if (!video) return
          const anchors: LocalNfoAnchor[] = []
          let anchorAfter = 0
          while (true) {
            const row = checked(() => { open(); return storage.queueNext(video.videoId, anchorAfter) })
            if (!row) break
            anchors.push(checked(() => hydrate(row.body)).anchor)
            anchorAfter = row.ordinal
          }
          after = video.ordinal
          yield checked(() => [video.videoId, { code: JSON.parse(video.code), anchors }] as [number, ScanNfoVideoBatch])
        }
      } }
    }) },
    dispose() { checked(() => {
      if (state === 'disposed') return
      storage.outside(); state = 'closing'
      storage.dispose(); lastMap = undefined; lastIdentity = undefined; state = 'disposed'
    }) }
  }
}

/** Request-private TEMP storage. Sidecars are rowwise SQL maps; every read completes
 * before yielding. A directory write remains one synchronous transaction, not a
 * whole-phase latency guarantee. Incoming readdir/maps and one video's complete
 * anchor array remain unbounded; this preserves the existing atomic apply contract.
 */
export function createScanNfoWorkset(db: Database.Database, roots: readonly Readonly<MediaLibraryRoot>[]): ScanNfoWorkset {
  return checked(() => {
    if (db.inTransaction) throw new Error('NFO workset cannot be created inside a caller transaction')
    const prefix = `scan_nfo_workset_${randomUUID().replaceAll('-', '')}`
    const d = `${prefix}_directories`, s = `${prefix}_sidecars`, p = `${prefix}_preflights`, v = `${prefix}_videos`, q = `${prefix}_queue`
    return db.transaction(() => {
      db.exec(`CREATE TEMP TABLE ${d}(key TEXT COLLATE BINARY PRIMARY KEY, sidecars TEXT, identity TEXT) WITHOUT ROWID;
        CREATE TEMP TABLE ${s}(snapshot TEXT, ordinal INTEGER, key TEXT COLLATE BINARY, value TEXT NOT NULL,
          PRIMARY KEY(snapshot,ordinal), UNIQUE(snapshot,key)) WITHOUT ROWID;
        CREATE TEMP TABLE ${p}(key TEXT COLLATE BINARY PRIMARY KEY, body TEXT NOT NULL, effective TEXT NOT NULL) WITHOUT ROWID;
        CREATE TEMP TABLE ${v}(ordinal INTEGER PRIMARY KEY, video_id INTEGER UNIQUE NOT NULL, code TEXT NOT NULL);
        CREATE TEMP TABLE ${q}(ordinal INTEGER PRIMARY KEY, video_id INTEGER NOT NULL, path TEXT COLLATE BINARY NOT NULL);
        CREATE INDEX ${prefix}_queue_video ON ${q}(video_id,ordinal);`)
      const statements = {
        directory: db.prepare(`SELECT sidecars,identity FROM ${d} WHERE key=?`),
        sidecars: db.prepare(`INSERT INTO ${d}(key,sidecars) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET sidecars=excluded.sidecars`),
        identity: db.prepare(`INSERT INTO ${d}(key,identity) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET identity=excluded.identity`),
        pair: db.prepare(`INSERT INTO ${s}(snapshot,ordinal,key,value) VALUES(?,?,?,?)`),
        pairGet: db.prepare(`SELECT value FROM ${s} WHERE snapshot=? AND key=?`),
        pairNext: db.prepare(`SELECT ordinal,key,value FROM ${s} WHERE snapshot=? AND ordinal>? ORDER BY ordinal LIMIT 1`),
        pairCount: db.prepare(`SELECT COUNT(*) AS count FROM ${s} WHERE snapshot=?`),
        preflight: db.prepare(`INSERT INTO ${p}(key,body,effective) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,effective=excluded.effective`),
        preflightGet: db.prepare(`SELECT body,effective FROM ${p} WHERE key=?`),
        effective: db.prepare(`SELECT effective FROM ${p} WHERE key=?`),
        video: db.prepare(`INSERT INTO ${v}(video_id,code) VALUES(?,?) ON CONFLICT(video_id) DO NOTHING`),
        queue: db.prepare(`INSERT INTO ${q}(video_id,path) VALUES(?,?)`),
        videoNext: db.prepare(`SELECT ordinal,video_id AS videoId,code FROM ${v} WHERE ordinal>? ORDER BY ordinal LIMIT 1`),
        queueNext: db.prepare(`SELECT q.ordinal,p.body FROM ${q} q JOIN ${p} p ON p.key=q.path
          WHERE q.video_id=? AND q.ordinal>? ORDER BY q.ordinal LIMIT 1`)
      }
      const transaction = db.transaction((fn: () => unknown) => fn())
      const storage: Storage = {
        transaction: <T>(fn: () => T): T => transaction(fn) as T,
        outside() { if (db.open && db.inTransaction) throw new Error('NFO workset mutation inside a caller transaction') },
        open() { if (!db.open) throw new Error('NFO workset database is closed') },
        directory(key) {
          const row = statements.directory.get(key) as {sidecars: string | null; identity: string | null} | undefined
          return row && { ...(row.sidecars === null ? {} : { sidecars: row.sidecars }), ...(row.identity === null ? {} : { identity: row.identity }) }
        },
        sidecars(key, snapshot) { statements.sidecars.run(key, snapshot) },
        identity(key, body) { statements.identity.run(key, body) },
        pair(snapshot, ordinal, key, value) { statements.pair.run(snapshot, ordinal, key, value) },
        pairGet(snapshot, key) { return (statements.pairGet.get(snapshot, key) as {value: string} | undefined)?.value },
        pairNext(snapshot, ordinal) { return statements.pairNext.get(snapshot, ordinal) as ReturnType<Storage['pairNext']> },
        pairCount(snapshot) { return (statements.pairCount.get(snapshot) as {count: number}).count },
        preflight(key, row) { statements.preflight.run(key, row.body, row.effective) },
        preflightGet(key) { return statements.preflightGet.get(key) as PreflightRow | undefined },
        effective(key) { return (statements.effective.get(key) as {effective: string} | undefined)?.effective },
        enqueue(videoId, code, key) { statements.video.run(videoId, code); statements.queue.run(videoId, key) },
        videoNext(ordinal) { return statements.videoNext.get(ordinal) as VideoRow | undefined },
        queueNext(videoId, ordinal) { return statements.queueNext.get(videoId, ordinal) as QueueRow | undefined },
        dispose() {
          if (!db.open) return
          transaction(() => { for (const table of [q, v, p, s, d]) db.exec(`DROP TABLE IF EXISTS temp.${table}`) })
        }
      }
      return workset(storage, roots)
    })()
  })
}

/** Detailed oracle intentionally retains the full workset in memory. */
export function createMemoryScanNfoWorkset(roots: readonly Readonly<MediaLibraryRoot>[]): ScanNfoWorkset {
  return checked(() => {
    const directories = new Map<string, Directory>()
    const sidecars = new Map<string, { byKey: Map<string, string>; rows: Array<{ordinal: number; key: string; value: string}> }>()
    const preflights = new Map<string, PreflightRow>(), videos = new Map<number, VideoRow>()
    const videoRows: VideoRow[] = []
    const queue = new Map<number, Array<{ordinal: number; key: string}>>()
    const storage: Storage = {
      transaction: fn => fn(), outside() {}, open() {},
      directory: key => directories.get(key),
      sidecars(key, snapshot) { directories.set(key, { ...directories.get(key), sidecars: snapshot }) },
      identity(key, body) { directories.set(key, { ...directories.get(key), identity: body }) },
      pair(snapshot, ordinal, key, value) {
        let entries = sidecars.get(snapshot)
        if (!entries) { entries = { byKey: new Map(), rows: [] }; sidecars.set(snapshot, entries) }
        entries.byKey.set(key, value)
        entries.rows.push({ ordinal, key, value })
      },
      pairGet: (snapshot, key) => sidecars.get(snapshot)?.byKey.get(key),
      pairNext: (snapshot, after) => sidecars.get(snapshot)?.rows[after],
      pairCount: snapshot => sidecars.get(snapshot)?.rows.length ?? 0,
      preflight(key, row) { preflights.set(key, row) },
      preflightGet: key => preflights.get(key), effective: key => preflights.get(key)?.effective,
      enqueue(videoId, code, key) {
        if (!videos.has(videoId)) {
          const video = { ordinal: videoRows.length + 1, videoId, code }
          videos.set(videoId, video); videoRows.push(video)
        }
        let rows = queue.get(videoId)
        if (!rows) { rows = []; queue.set(videoId, rows) }
        rows.push({ ordinal: rows.length + 1, key })
      },
      videoNext: after => videoRows[after],
      queueNext(videoId, after) {
        const row = queue.get(videoId)?.[after]
        return row && { ordinal: row.ordinal, body: preflights.get(row.key)!.body }
      },
      dispose() { directories.clear(); sidecars.clear(); preflights.clear(); videos.clear(); videoRows.length = 0; queue.clear() }
    }
    return workset(storage, roots, true)
  })
}
