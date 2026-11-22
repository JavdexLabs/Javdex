import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { VideoCard } from '@shared/videoTypes'
import type { CatalogIdentity } from '@shared/protocol/identity'
import { DIRECT_ID_BATCH_MAX } from '@shared/protocol/limits'
import { RECENT_PLAYBACK_LIST_ID, type RecentPlaybackMetadata, type RecentPlaybackPageQuery } from '@shared/desktop/recentPlayback'
import type { PlaylistVideosPage } from '@shared/playlistTypes'
import type { CatalogBackend } from '../application/catalogBackend'

const MAX_ENTRIES = 1000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const catalogSchema = z.string().regex(/^[a-f0-9]{64}$/)
const timestampSchema = z.number().int().nonnegative().max(253402300799999)
const videoIdSchema = z.number().int().positive()
const entrySchema = z.object({ catalog: catalogSchema, playedAt: timestampSchema, videoId: videoIdSchema }).strict()
const legacyEntrySchema = z.object({ catalog: catalogSchema, playedAt: timestampSchema, video: z.object({ id: videoIdSchema }) }).strict()
  .transform(({ catalog, playedAt, video }) => ({ catalog, playedAt, videoId: video.id }))
const fileSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), entries: z.array(legacyEntrySchema).max(MAX_ENTRIES) }).strict(),
  z.object({ version: z.literal(2), entries: z.array(entrySchema).max(MAX_ENTRIES) }).strict()
])
type Entry = z.infer<typeof entrySchema>

function byMostRecent(a: Entry, b: Entry): number {
  return b.playedAt - a.playedAt || b.videoId - a.videoId
}

function uniqueEntries(entries: Entry[]): Entry[] {
  const unique = new Map<string, Entry>()
  for (const entry of entries) {
    const key = `${entry.catalog}:${entry.videoId}`
    if ((unique.get(key)?.playedAt ?? -1) <= entry.playedAt) unique.set(key, entry)
  }
  return [...unique.values()]
}

export function recentPlaybackCatalogKey(identity: CatalogIdentity): string {
  return createHash('sha256').update(JSON.stringify([identity.mode, identity.catalogId,
    identity.mode === 'remote' ? identity.serverId ?? null : null])).digest('hex')
}

/** Device-only playback timestamps. Current display data comes from the catalog. */
export function createRecentPlayback(backend: Pick<CatalogBackend, 'identity' | 'generation'> & { queries: Pick<CatalogBackend['queries'], 'videoCardsByIds'> },
  filename: string, changed: () => void = () => {}, now = Date.now) {
  let lastStartedAt = 0
  let revision = 0
  function read(): { entries: Entry[]; legacy: boolean } {
    try {
      if (fs.statSync(filename).size > MAX_FILE_BYTES) throw new Error('History file too large')
      const { version, entries } = fileSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')))
      return { entries: uniqueEntries(entries), legacy: version === 1 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], legacy: false }
      throw new Error('无法读取本机最近播放记录')
    }
  }
  function write(entries: Entry[], notify = true): void {
    const sorted = uniqueEntries(entries).sort(byMostRecent).slice(0, MAX_ENTRIES)
    const serialized = JSON.stringify({ version: 2, entries: sorted })
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    const temporary = `${filename}.tmp-${randomUUID()}`
    try {
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, filename)
    } catch { throw new Error('无法保存本机最近播放记录') }
    finally { try { fs.unlinkSync(temporary) } catch { /* Consumed by atomic rename. */ } }
    revision++
    if (notify) changed()
  }
  async function current(): Promise<{ entries: Entry[]; cards: Map<number, VideoCard> | null }> {
    const catalog = recentPlaybackCatalogKey(backend.identity), generation = backend.generation
    const assertCurrent = (): void => {
      if (generation !== backend.generation || catalog !== recentPlaybackCatalogKey(backend.identity)) {
        throw new Error('资料库已切换，请刷新最近播放')
      }
    }
    for (;;) {
      const initialRevision = revision
      const { entries: all, legacy } = read()
      // Always send IDs in numeric order instead of playback order.
      const ids = all.filter(entry => entry.catalog === catalog).map(entry => entry.videoId).sort((a, b) => a - b)
      const cards = new Map<number, VideoCard>()
      let available = true
      try {
        for (let offset = 0; offset < ids.length; offset += DIRECT_ID_BATCH_MAX) {
          const batch = ids.slice(offset, offset + DIRECT_ID_BATCH_MAX)
          const found = await backend.queries.videoCardsByIds({ videoIds: batch })
          assertCurrent()
          for (const card of found) cards.set(card.id, card)
        }
      } catch (error) {
        assertCurrent()
        if (backend.identity.mode !== 'remote') throw error
        available = false
      }
      // A concurrent playback, removal or migration requires a fresh view of the history.
      if (revision !== initialRevision) continue
      const retained = available ? all.filter(entry => entry.catalog !== catalog || cards.has(entry.videoId)) : all
      const pruned = retained.length !== all.length
      if (legacy || pruned) write(retained, pruned)
      const entries = retained.filter(entry => entry.catalog === catalog).sort(byMostRecent)
      return { entries, cards: available ? cards : null }
    }
  }
  return {
    started(videoId: number): void {
      const catalog = recentPlaybackCatalogKey(backend.identity)
      const { entries } = read()
      const playedAt = Math.max(now(), lastStartedAt + 1, ...entries.map(entry => entry.playedAt + 1))
      const entry = entrySchema.parse({ catalog, playedAt, videoId })
      write([...entries, entry])
      lastStartedAt = playedAt
    },
    async metadata(): Promise<RecentPlaybackMetadata> {
      const { entries } = await current()
      return { id: RECENT_PLAYBACK_LIST_ID, name: '最近播放', description: '仅此设备 · 按最近一次播放倒序',
        local_kind: 'recently_played', system_kind: null, cover_path: null, preview_cover_path: null,
        created_at: '', updated_at: entries[0] ? new Date(entries[0].playedAt).toISOString() : null,
        links: [], video_count: entries.length, contains_video: false }
    },
    async page(query: RecentPlaybackPageQuery): Promise<PlaylistVideosPage> {
      const { limit = 60, offset = 0, resourceKinds = [] } = query
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('历史分页参数无效')
      const { entries, cards } = await current()
      if (!cards) throw new Error('暂时无法读取资料库中的影片，请连接后重试')
      const videos = entries.flatMap(entry => cards.get(entry.videoId) ?? [])
      const filtered = videos.filter(video => !resourceKinds.length || resourceKinds.some(kind =>
        kind === 'none' ? !video.resource_kinds?.length : video.resource_kinds?.includes(kind)))
      return { videos: filtered.slice(offset, offset + limit),
        total: entries.length, filteredTotal: filtered.length, offset, limit }
    },
    remove(videoId: number): void {
      const catalog = recentPlaybackCatalogKey(backend.identity)
      write(read().entries.filter(entry => entry.catalog !== catalog || entry.videoId !== videoId))
    },
    clear(): void {
      const catalog = recentPlaybackCatalogKey(backend.identity)
      write(read().entries.filter(entry => entry.catalog !== catalog))
    }
  }
}
