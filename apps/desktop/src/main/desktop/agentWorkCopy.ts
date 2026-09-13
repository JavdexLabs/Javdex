import type Database from 'better-sqlite3'
import { AGENT_METADATA_SCHEMA_SQL, AGENT_PLATFORM_SCHEMA_SQL } from '@library/db/schema'
import {
  AGENT_WORK_TABLES,
  configureAgentWorkTablePrefix,
  qualifyAgentSql
} from '@library/runtime/host'

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
  dest.exec(`ATTACH DATABASE ${sqlitePathLiteral(source.name)} AS catalog`)
  try {
    dest.pragma('foreign_keys = OFF')
    dest.transaction(() => {
      for (const table of AGENT_WORK_TABLES) {
        dest.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM catalog.${table}`)
      }
    })()
    dest.pragma('foreign_keys = ON')
  } finally {
    dest.exec('DETACH DATABASE catalog')
  }

  const tables: AgentWorkCopyResult['tables'] = {}
  for (const table of AGENT_WORK_TABLES) {
    const sourceCount = tableCount(source, table)
    const destCount = tableCount(dest, table)
    if (destCount < sourceCount) {
      throw new Error(`工作记录复制不完整：${table} 源 ${sourceCount} 行，目标 ${destCount} 行`)
    }
    tables[table] = { source: sourceCount, dest: destCount }
  }
  return { tables }
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
