import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { toVideoCard } from '@shared/cardProjection'
import { videoCardSchema } from '@shared/catalogDetailSchemas'
import type { CatalogIdentity } from '@shared/protocol/identity'
import { DIRECT_ID_BATCH_MAX } from '@shared/protocol/limits'
import { RECENT_PLAYBACK_LIST_ID, type RecentPlaybackMetadata, type RecentPlaybackPageQuery } from '@shared/desktop/recentPlayback'
import type { PlaylistVideosPage } from '@shared/playlistTypes'
import type { CatalogBackend } from '../application/catalogBackend'

const MAX_ENTRIES = 1000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const entrySchema = z.object({
  catalog: z.string().regex(/^[a-f0-9]{64}$/), playedAt: z.number().int().nonnegative().max(253402300799999),
  video: videoCardSchema.extend({ id: z.number().int().positive(), code: z.string().max(256),
    title: z.string().max(1024).nullable(), cover_path: z.string().max(4096).nullable() })
}).strict()
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(MAX_ENTRIES) }).strict()
type Entry = z.infer<typeof entrySchema>

function uniqueEntries(entries: Entry[]): Entry[] {
  const unique = new Map<string, Entry>()
  for (const entry of entries) {
    const key = `${entry.catalog}:${entry.video.id}`
    if ((unique.get(key)?.playedAt ?? -1) <= entry.playedAt) unique.set(key, entry)
  }
  return [...unique.values()]
}

export function recentPlaybackCatalogKey(identity: CatalogIdentity): string {
  return createHash('sha256').update(JSON.stringify([identity.mode, identity.catalogId,
    identity.mode === 'remote' ? identity.serverId ?? null : null])).digest('hex')
}

/** Device-only snapshots: no resource locators, playback grants, or catalog mutations. */
export function createRecentPlayback(backend: Pick<CatalogBackend, 'identity' | 'generation'> & { queries: Pick<CatalogBackend['queries'], 'getVideo' | 'existingVideoIds'> },
  filename: string, changed: () => void = () => {}, now = Date.now) {
  const pending = new Set<{ catalog: string; videoId: number; cancelled: boolean }>()
  let lastStartedAt = 0
  let revision = 0
  function read(): Entry[] {
    try {
      if (fs.statSync(filename).size > MAX_FILE_BYTES) throw new Error('History file too large')
      const entries = fileSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8'))).entries
      return uniqueEntries(entries)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('无法读取本机最近播放记录')
    }
  }
  function write(entries: Entry[]): void {
    const sorted = uniqueEntries(entries).sort((a, b) => b.playedAt - a.playedAt || b.video.id - a.video.id).slice(0, MAX_ENTRIES)
    let serialized = JSON.stringify({ version: 1, entries: sorted })
    // Character limits do not bound UTF-8 bytes. Every successful write must be readable.
    while (Buffer.byteLength(serialized) > MAX_FILE_BYTES && sorted.length) {
      sorted.pop()
      serialized = JSON.stringify({ version: 1, entries: sorted })
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    const temporary = `${filename}.tmp-${randomUUID()}`
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, filename)
    } catch { throw new Error('无法保存本机最近播放记录') }
    finally { try { fs.unlinkSync(temporary) } catch { /* Consumed by atomic rename. */ } }
    revision++
    changed()
  }
  async function current(): Promise<Entry[]> {
    const catalog = recentPlaybackCatalogKey(backend.identity), generation = backend.generation
    const initialRevision = revision
    const all = read()
    const entries = all.filter(entry => entry.catalog === catalog)
    if (!entries.length) return []
    const assertCurrent = (): void => {
      if (generation !== backend.generation || catalog !== recentPlaybackCatalogKey(backend.identity)) {
        throw new Error('资料库已切换，请刷新最近播放')
      }
    }
    // Never send playback order, timestamps or snapshots to the catalog.
    entries.sort((a, b) => a.video.id - b.video.id)
    const missing = new Map<number, number>()
    for (let offset = 0; offset < entries.length; offset += DIRECT_ID_BATCH_MAX) {
      const batch = entries.slice(offset, offset + DIRECT_ID_BATCH_MAX)
      let found: number[]
      try {
        found = await backend.queries.existingVideoIds({ videoIds: batch.map(entry => entry.video.id) })
      } catch (error) {
        assertCurrent()
        if (backend.identity.mode !== 'remote') throw error
        // Offline or older servers cannot confirm deletion. Keep the device history.
        missing.clear()
        break
      }
      assertCurrent()
      const present = new Set(found)
      for (const entry of batch) {
        if (!present.has(entry.video.id)) missing.set(entry.video.id, entry.playedAt)
      }
    }
    // Merge with fresh history: a concurrent replay, clear or another catalog's
    // write may have happened while a batch was in flight.
    const latest = initialRevision === revision ? all : read()
    const retained = latest.filter(entry => entry.catalog !== catalog || missing.get(entry.video.id) !== entry.playedAt)
    if (retained.length !== latest.length) write(retained)
    return retained.filter(entry => entry.catalog === catalog).sort((a, b) => b.playedAt - a.playedAt || b.video.id - a.video.id)
  }
  return {
    async started(videoId: number): Promise<void> {
      const catalog = recentPlaybackCatalogKey(backend.identity), generation = backend.generation
      const playedAt = Math.max(now(), lastStartedAt + 1, ...read().map(entry => entry.playedAt + 1))
      lastStartedAt = playedAt
      const ticket = { catalog, videoId, cancelled: false }
      pending.add(ticket)
      try {
        const video = await backend.queries.getVideo({ scope: { kind: 'all' }, videoId })
        if (!video || ticket.cancelled || generation !== backend.generation || catalog !== recentPlaybackCatalogKey(backend.identity)) return
        const entry = entrySchema.parse({ catalog, playedAt, video: toVideoCard({ ...video,
          code: video.code.slice(0, 256), title: video.title?.slice(0, 1024) ?? null }) })
        // An older, slow metadata read cannot replace a more recent play of the same video.
        const entries = read()
        if (entries.some(old => old.catalog === catalog && old.video.id === videoId && old.playedAt > playedAt)) return
        write([...entries.filter(old => old.catalog !== catalog || old.video.id !== videoId), entry])
      } finally { pending.delete(ticket) }
    },
    async metadata(): Promise<RecentPlaybackMetadata> {
      const entries = await current()
      return { id: RECENT_PLAYBACK_LIST_ID, name: '最近播放', description: '仅此设备 · 按最近一次播放倒序',
        local_kind: 'recently_played', system_kind: null, cover_path: null, preview_cover_path: null,
        created_at: '', updated_at: entries[0] ? new Date(entries[0].playedAt).toISOString() : null,
        links: [], video_count: entries.length, contains_video: false }
    },
    async page(query: RecentPlaybackPageQuery): Promise<PlaylistVideosPage> {
      const { limit = 60, offset = 0, resourceKinds = [] } = query
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('历史分页参数无效')
      const entries = await current()
      const filtered = entries.filter(entry => !resourceKinds.length || resourceKinds.some(kind =>
        kind === 'none' ? !entry.video.resource_kinds?.length : entry.video.resource_kinds?.includes(kind)))
      return { videos: filtered.slice(offset, offset + limit).map(entry => entry.video),
        total: entries.length, filteredTotal: filtered.length, offset, limit }
    },
    remove(videoId: number): void {
      const catalog = recentPlaybackCatalogKey(backend.identity)
      for (const ticket of pending) if (ticket.catalog === catalog && ticket.videoId === videoId) ticket.cancelled = true
      write(read().filter(entry => entry.catalog !== catalog || entry.video.id !== videoId))
    },
    clear(): void {
      const catalog = recentPlaybackCatalogKey(backend.identity)
      for (const ticket of pending) if (ticket.catalog === catalog) ticket.cancelled = true
      write(read().filter(entry => entry.catalog !== catalog))
    }
  }
}
