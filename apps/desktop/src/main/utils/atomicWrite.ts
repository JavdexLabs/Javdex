import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function atomicWrite(filename: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temporary, filename) }
  finally { await fs.rm(temporary, { force: true }) }
}
