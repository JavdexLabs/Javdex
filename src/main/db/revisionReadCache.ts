import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'

export interface ReadCacheBudget { maxEntries: number; maxBytes: number }
export interface ReadCacheMemo {
  readonly revision?: string
  get<T>(bucket: string, key: string, load: () => T): T
}
interface Entry { json: string; bytes: number }

const revisionReaders = new WeakMap<Database.Database, () => string>()

/** Call within the transaction producing the page. Connection identity is process/reopen unique. */
export function readSnapshotRevision(database: Database.Database): string {
  let read = revisionReaders.get(database)
  if (!read) {
    const identity = randomUUID()
    const changes = database.prepare('SELECT total_changes() AS revision_changes')
    read = () => JSON.stringify([
      identity,
      database.pragma('main.schema_version', { simple: true }),
      database.pragma('main.data_version', { simple: true }),
      (changes.get() as { revision_changes: number }).revision_changes
    ])
    revisionReaders.set(database, read)
  }
  return read()
}

/** Connection-owned read-through cache. Budgets count encoded keys/results, not RSS or
 * transient serialization. FIFO eviction is per bucket; in-flight staging has the
 * same additional budget until commit. Oversized results return without admission.
 * Caller transactions bypass both lookup and publication. The owned read transaction
 * pins the schema snapshot before checking revisions, so cached counts and fresh pages
 * belong to the same snapshot. Failed/externally invalidated reads publish nothing.
 */
export function createRevisionReadCache(database: Database.Database, budgets: Record<string, ReadCacheBudget>) {
  const buckets = new Map<string, Map<string, Entry>>()
  for (const [name, budget] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(budget.maxEntries) || budget.maxEntries < 1 || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) throw new Error('Invalid read cache budget')
    buckets.set(name, new Map())
  }
  const revision = () => readSnapshotRevision(database)
  let previousRevision: string | undefined
  const admit = (map: Map<string, Entry>, key: string, entry: Entry, budget: ReadCacheBudget) => {
    if (entry.bytes > budget.maxBytes) return
    map.delete(key)
    let bytes = [...map.values()].reduce((sum, value) => sum + value.bytes, 0)
    while (map.size >= budget.maxEntries || bytes + entry.bytes > budget.maxBytes) {
      const oldest = map.keys().next().value as string
      bytes -= map.get(oldest)!.bytes
      map.delete(oldest)
    }
    map.set(key, entry)
  }
  return {
    read<T>(read: (memo: ReadCacheMemo & { readonly revision: string }) => T): T {
      // A caller can roll back after reading; total_changes does not roll back.
      // Do not let that uncommitted page share an identity with a later durable page.
      if (database.inTransaction) return read({
        revision: `${revision()}:${randomUUID()}`,
        get: (_bucket, _key, load) => load()
      })
      const staged = new Map<string, Map<string, Entry>>()
      let snapshotRevision = ''
      const result = database.transaction(() => {
        snapshotRevision = revision()
        if (snapshotRevision !== previousRevision) {
          for (const map of buckets.values()) map.clear()
          previousRevision = snapshotRevision
        }
        const memo: ReadCacheMemo & { readonly revision: string } = {
          revision: snapshotRevision,
          get<U>(bucket: string, key: string, load: () => U): U {
            const cached = buckets.get(bucket), budget = budgets[bucket]
            if (!cached || !budget) throw new Error('Unknown read cache bucket')
            const hit = staged.get(bucket)?.get(key) ?? cached.get(key)
            if (hit) return JSON.parse(hit.json) as U
            const value = load()
            // Keys derived from queries can also be large; do not serialize an
            // already ineligible result merely to discover it cannot be cached.
            const keyBytes = Buffer.byteLength(key)
            if (keyBytes > budget.maxBytes) return value
            const json = JSON.stringify(value)
            if (json === undefined) return value
            const entry = { json, bytes: keyBytes + Buffer.byteLength(json) }
            if (entry.bytes <= budget.maxBytes && isDeepStrictEqual(value, JSON.parse(json))) {
              // Optional own properties set to undefined, sparse arrays and other
              // non-JSON shapes must not change on a hit; bypass instead of coercing.
              let pending = staged.get(bucket)
              if (!pending) { pending = new Map(); staged.set(bucket, pending) }
              admit(pending, key, entry, budget)
            }
            return value
          }
        }
        return read(memo)
      })()
      if (snapshotRevision === revision()) {
        for (const [name, entries] of staged) for (const [key, entry] of entries) admit(buckets.get(name)!, key, entry, budgets[name])
      }
      return result
    }
  }
}
