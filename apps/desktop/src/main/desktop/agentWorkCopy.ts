import type Database from 'better-sqlite3'
import fs from 'node:fs'
import { AGENT_METADATA_SCHEMA_SQL, AGENT_PLATFORM_SCHEMA_SQL } from '@library/db/schema'
import {
  AGENT_WORK_TABLES,
  configureAgentWorkTablePrefix,
  qualifyAgentSql
} from '@library/runtime/host'

/** Test-only: pause inside the open copy SQL transaction so a test can SIGKILL before commit. */
function stallCopySqlForTests(): void {
  const instructionPath = process.env.JAVDEX_TEST_STALL_COPY_SQL
  if (!instructionPath || !fs.existsSync(instructionPath)) return
  try {
    fs.unlinkSync(instructionPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  fs.writeFileSync(`${instructionPath}.ready`, '1')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (fs.existsSync(`${instructionPath}.done`)) return
    const slice = Date.now() + 20
    while (Date.now() < slice) {
      // Keep the INSERT OR REPLACE transaction open until the test SIGKILLs this process.
    }
  }
  throw new Error('JAVDEX_TEST_STALL_COPY_SQL timed out inside the copy transaction')
}

export function sqlitePathLiteral(filePath: string): string {
  return `'${filePath.replaceAll("'", "''")}'`
}

export function ensureAgentWorkSchema(database: Database.Database): void {
  database.exec(AGENT_PLATFORM_SCHEMA_SQL)
  database.exec(AGENT_METADATA_SCHEMA_SQL)
}

function tableCount(database: Database.Database, table: string): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count
}

export interface AgentWorkCopyResult {
  tables: Record<string, { source: number; dest: number }>
}

/** Idempotent copy. Never deletes source rows. Destination rows are replaced by primary key. */
export function copyAgentWorkTables(
  source: Database.Database,
  dest: Database.Database
): AgentWorkCopyResult {
  ensureAgentWorkSchema(dest)
  const hasMeta = dest.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_meta'").get()
  if (hasMeta && (dest.prepare("SELECT value FROM work_meta WHERE key = 'prepStatus'").get() as { value: string } | undefined)?.value === 'ready') {
    throw new Error('工作记录已就绪，不能用旧资料库覆盖')
  }
  const foreignKeys = dest.pragma('foreign_keys', { simple: true }) as number
  dest.exec(`ATTACH DATABASE ${sqlitePathLiteral(source.name)} AS catalog`)
  try {
    dest.pragma('foreign_keys = OFF')
    return dest.transaction(() => {
      for (const table of AGENT_WORK_TABLES) {
        dest.exec(`INSERT OR REPLACE INTO main.${table} SELECT * FROM catalog.${table}`)
      }
      // Validate the same source snapshot before commit. Equal counts alone
      // cannot detect changed fields, replaced IDs or corrupted ciphertext.
      const tables: AgentWorkCopyResult['tables'] = {}
      for (const table of AGENT_WORK_TABLES) {
        const mismatch = dest.prepare(`SELECT * FROM catalog.${table} EXCEPT SELECT * FROM main.${table} LIMIT 1`).get()
        if (mismatch) throw new Error(`工作记录复制内容不一致：${table}`)
        const invalidReference = dest.prepare(`PRAGMA main.foreign_key_check(${table})`).get()
        if (invalidReference) throw new Error(`工作记录外键校验失败：${table}`)
        tables[table] = { source: tableCount(dest, `catalog.${table}`), dest: tableCount(dest, `main.${table}`) }
      }
      stallCopySqlForTests()
      return { tables }
    })()
  } finally {
    try {
      dest.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
    } finally {
      dest.exec('DETACH DATABASE catalog')
    }
  }
}

function alreadyAttached(database: Database.Database, schema: string): boolean {
  const rows = database.prepare('SELECT name FROM pragma_database_list').all() as Array<{
    name: string
  }>
  return rows.some((row) => row.name === schema)
}

function wrapCatalogSqlForAgentPrefix(database: Database.Database): void {
  const wrapped = database as Database.Database & { __javdexAgentSqlWrapped?: boolean }
  if (wrapped.__javdexAgentSqlWrapped) return
  const originalPrepare = database.prepare.bind(database)
  const originalExec = database.exec.bind(database)
  database.prepare = ((sql: string) => originalPrepare(qualifyAgentSql(sql))) as typeof database.prepare
  database.exec = ((sql: string) => originalExec(qualifyAgentSql(sql))) as typeof database.exec
  wrapped.__javdexAgentSqlWrapped = true
}

/** Local writer sees workStore agent tables as work.* after this attach. */
export function attachAgentWorkStore(
  catalog: Database.Database,
  workStorePath: string
): void {
  if (!alreadyAttached(catalog, 'work')) {
    catalog.exec(`ATTACH DATABASE ${sqlitePathLiteral(workStorePath)} AS work`)
  }
  configureAgentWorkTablePrefix('work.')
  wrapCatalogSqlForAgentPrefix(catalog)
}
