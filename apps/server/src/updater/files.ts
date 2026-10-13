import fs from 'node:fs'
import path from 'node:path'

export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp`
  const fd = fs.openSync(temporary, 'w', 0o600)
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, file)
  syncDirectory(path.dirname(file))
}
export function readJsonIfExists(file: string): unknown | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
