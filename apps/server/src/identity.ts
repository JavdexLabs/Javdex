import fs from 'node:fs'
import path from 'node:path'

const BIND_FILE = 'instance-bind.json'

export interface InstanceBindRecord {
  schema: 1
  bound: true
  boundAt: string
}

function bindPath(dataDir: string): string {
  return path.join(dataDir, BIND_FILE)
}

function parseBindRecord(value: unknown): InstanceBindRecord | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== 1 ||
    (value as { bound?: unknown }).bound !== true ||
    typeof (value as { boundAt?: unknown }).boundAt !== 'string'
  ) {
    return null
  }
  return value as InstanceBindRecord
}

export function isInstanceBound(dataDir: string): boolean {
  const file = bindPath(dataDir)
  if (!fs.existsSync(file)) return false
  try {
    return parseBindRecord(JSON.parse(fs.readFileSync(file, 'utf8'))) !== null
  } catch {
    return false
  }
}

/** Deploy-time occupancy marker. Not a writer token, serverId, or recovery password. */
export function bindInstance(dataDir: string, now = () => new Date().toISOString()): InstanceBindRecord {
  fs.mkdirSync(dataDir, { recursive: true })
  const existing = isInstanceBound(dataDir)
  if (existing) {
    return parseBindRecord(JSON.parse(fs.readFileSync(bindPath(dataDir), 'utf8'))) as InstanceBindRecord
  }
  const record: InstanceBindRecord = { schema: 1, bound: true, boundAt: now() }
  const temporary = `${bindPath(dataDir)}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, bindPath(dataDir))
  return record
}
