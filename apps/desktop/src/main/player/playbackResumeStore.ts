import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CatalogIdentity } from '@shared/protocol/identity'

const MAX_RECORDS = 1000
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const keySchema = z.string().regex(/^[a-f0-9]{64}$/)
const seconds = z.number().finite().nonnegative().max(604800)
const entrySchema = z.object({
  key: keySchema, position: seconds, duration: seconds.nullable(),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict()
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(MAX_RECORDS) }).strict()
type Entry = z.infer<typeof entrySchema>
export type ResumePoint = Pick<Entry, 'position' | 'duration'>

/** Stable content identity, not the authorization/session generation used for live validation.
 * Digest avoids writing paths or grants even if a future locator revision contains them.
 * This is not encryption: positions and timestamps remain sensitive device data.
 */
export function playbackResumeKey(identity: CatalogIdentity, resourceId: number, revision: string): string {
  return createHash('sha256').update(JSON.stringify([
    identity.mode, identity.catalogId, identity.mode === 'remote' ? identity.serverId ?? null : null,
    resourceId, revision
  ])).digest('hex')
}

function resumable(point: ResumePoint): boolean {
  return point.position >= 30 && (point.duration == null || point.duration - point.position > 30)
}

/** All normal access is gated before filesystem IO. Explicit clearing is separate and
 * must only be called after the user's confirmation, even when recording is disabled.
 * The main process is the sole writer; synchronous atomic replacement prevents lost updates.
 */
export function createPlaybackResumeStore(file: string, enabled: () => boolean, now = Date.now) {
  function read(preserveExpired = false): Entry[] {
    try {
      if (fs.statSync(file).size > 1024 * 1024) throw new Error('Progress file too large')
      const data = fileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (preserveExpired) return data.entries
      const time = now()
      const unique = new Map<string, Entry>()
      for (const entry of data.entries) {
        if (entry.updatedAt > time || time - entry.updatedAt > MAX_AGE_MS || !resumable(entry)) continue
        if ((unique.get(entry.key)?.updatedAt ?? -1) <= entry.updatedAt) unique.set(entry.key, entry)
      }
      return [...unique.values()]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      // Do not replace an unreadable/newer-version file with an empty store.
      throw new Error('无法读取本机续播记录')
    }
  }
  function write(entries: Entry[]): void {
    const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)).slice(0, MAX_RECORDS)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${randomUUID()}`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: sorted }), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, file)
    } catch {
      throw new Error('无法保存本机续播记录')
    } finally {
      // Only this invocation's exact temporary file; never the previous progress file.
      try { fs.unlinkSync(temporary) } catch { /* Rename normally consumed it. */ }
    }
  }
  return {
    get(key: string, privateSession = false): ResumePoint | null {
      if (!enabled() || privateSession) return null
      keySchema.parse(key)
      const entry = read().find(item => item.key === key)
      return entry ? { position: entry.position, duration: entry.duration } : null
    },
    save(key: string, point: ResumePoint | null, privateSession = false): void {
      if (!enabled() || privateSession) return
      keySchema.parse(key)
      const entry = point == null ? null : entrySchema.parse({ key, position: point.position, duration: point.duration, updatedAt: now() })
      const entries = read().filter(item => item.key !== key)
      if (entry && resumable(entry)) entries.push(entry)
      // Below 30 seconds, near the end, or EOF removes an older point, but does not
      // create a file for a first short play. Actual-start gating belongs to the session.
      if (entries.length || fs.existsSync(file)) write(entries)
    },
    clearConfirmed(key?: string): void {
      if (key == null) {
        try { fs.unlinkSync(file) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法清除本机续播记录') }
        return
      }
      keySchema.parse(key)
      const entries = read(true).filter(item => item.key !== key)
      if (fs.existsSync(file)) write(entries)
    }
  }
}
