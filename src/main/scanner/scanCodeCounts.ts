import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export const SCAN_CODE_COUNTS_MAX_OCCURRENCES = 256
export const SCAN_CODE_COUNTS_MAX_BYTES = 1024 * 1024

export class ScanCodeCountsError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Scan code counts failed', { cause })
    this.name = 'ScanCodeCountsError'
  }
}

export interface ScanCodeCounts {
  add(code: string): boolean
  finishCounting(): void
  get(code: string): number
  decrement(code: string): void
  freeze(): void
  dispose(): void
}

function checked<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof ScanCodeCountsError) throw error
    throw new ScanCodeCountsError(error)
  }
}

// Well-formed JSON escapes lone surrogates and NUL while retaining exact JS string identity.
// SQLite sees only valid UTF-8, using BINARY comparison without normalization.
function encode(code: string): string {
  if (typeof code !== 'string') throw new Error('Invalid scan code')
  // Encoded JSON is never shorter than the UTF-16 code-unit count. Reject huge
  // inputs before allocation; accepted raw input may still expand to ~6x + quotes.
  if (code.length > SCAN_CODE_COUNTS_MAX_BYTES) throw new Error('Scan code exceeds 1 MiB encoded key limit')
  const key = JSON.stringify(code)
  if (Buffer.byteLength(key, 'utf8') > SCAN_CODE_COUNTS_MAX_BYTES) throw new Error('Scan code exceeds 1 MiB encoded key limit')
  return key
}

type State = 'counting' | 'adjusting' | 'frozen' | 'closing' | 'disposed'

/** Request-local scratch counts. Encoded-key budget excludes transient encoding allocation.
 * No mutation may run in a caller transaction; reads may. Failed add does not accept its occurrence.
 */
export function createScanCodeCounts(database: Database.Database): ScanCodeCounts {
  return checked(() => {
    if (database.inTransaction) throw new Error('Scan code counts cannot be created inside a caller transaction')
    const table = `scan_code_counts_${randomUUID().replaceAll('-', '')}`
    const statements = database.transaction(() => {
      database.exec(`CREATE TEMP TABLE ${table} (
        code TEXT COLLATE BINARY PRIMARY KEY, count INTEGER NOT NULL
        CHECK(typeof(count)='integer' AND count>=0 AND count<=9007199254740991)
      ) WITHOUT ROWID`)
      return {
        insert: database.prepare(`INSERT INTO temp.${table}(code,count) VALUES(?,1)
          ON CONFLICT(code) DO UPDATE SET count=count+1`),
        get: database.prepare(`SELECT count FROM temp.${table} WHERE code=?`),
        decrement: database.prepare(`UPDATE temp.${table} SET count=count-1 WHERE code=? AND count>0`)
      }
    })()
    let state: State = 'counting'
    let keys: string[] = [], bytes = 0
    const open = () => {
      if (state === 'closing' || state === 'disposed' || !database.open) throw new Error('Scan code counts are closed')
    }
    const outside = () => {
      if (database.inTransaction) throw new Error('Scan code counts mutation inside a caller transaction')
    }
    const requireState = (expected: State) => {
      open()
      if (state !== expected) throw new Error(`Scan code counts must be ${expected}`)
    }
    const writeBatch = database.transaction(() => {
      for (const key of keys) statements.insert.run(key)
    })
    const decrement = database.transaction((key: string) => statements.decrement.run(key))
    const flush = () => {
      if (!keys.length) return
      writeBatch()
      keys = []
      bytes = 0
    }
    return {
      add(code) { return checked(() => {
        outside(); requireState('counting')
        const key = encode(code), size = Buffer.byteLength(key, 'utf8')
        let flushed = false
        if (bytes + size > SCAN_CODE_COUNTS_MAX_BYTES) { flush(); flushed = true }
        keys.push(key); bytes += size
        if (keys.length === SCAN_CODE_COUNTS_MAX_OCCURRENCES || bytes === SCAN_CODE_COUNTS_MAX_BYTES) {
          try { flush(); flushed = true } catch (error) { keys.pop(); bytes -= size; throw error }
        }
        return flushed
      }) },
      finishCounting() { checked(() => { outside(); requireState('counting'); flush(); state = 'adjusting' }) },
      get(code) { return checked(() => {
        open()
        if (state === 'counting') throw new Error('Scan code counts have not finished counting')
        const row = statements.get.get(encode(code)) as { count: number } | undefined
        return row?.count ?? 0
      }) },
      decrement(code) { checked(() => {
        outside(); requireState('adjusting')
        const key = encode(code)
        decrement(key)
      }) },
      freeze() { checked(() => { outside(); requireState('adjusting'); state = 'frozen' }) },
      dispose() { checked(() => {
        if (state === 'disposed') return
        if (database.open) outside()
        state = 'closing'
        if (database.open) database.exec(`DROP TABLE IF EXISTS temp.${table}`)
        keys = []; bytes = 0; state = 'disposed'
      }) }
    }
  })
}

/** Legacy oracle: intentionally stores all distinct keys in memory. */
export function createMemoryScanCodeCounts(): ScanCodeCounts {
  const counts = new Map<string, number>()
  let state: State = 'counting'
  const requireState = (expected: State) => {
    if (state !== expected) throw new Error(`Scan code counts must be ${expected}`)
  }
  return {
    add(code) { return checked(() => {
      requireState('counting'); encode(code)
      const next = (counts.get(code) ?? 0) + 1
      if (!Number.isSafeInteger(next)) throw new Error('Scan code count exceeds safe integer limit')
      counts.set(code, next)
      return false
    }) },
    finishCounting() { checked(() => { requireState('counting'); state = 'adjusting' }) },
    get(code) { return checked(() => {
      if (state !== 'adjusting' && state !== 'frozen') throw new Error('Scan code counts are not readable')
      encode(code); return counts.get(code) ?? 0
    }) },
    decrement(code) { checked(() => {
      requireState('adjusting'); encode(code)
      if (counts.has(code)) counts.set(code, Math.max(0, counts.get(code)! - 1))
    }) },
    freeze() { checked(() => { requireState('adjusting'); state = 'frozen' }) },
    dispose() { checked(() => { counts.clear(); state = 'disposed' }) }
  }
}
