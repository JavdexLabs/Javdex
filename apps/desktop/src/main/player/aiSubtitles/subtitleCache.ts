import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { PlaybackSource } from '../playbackSource'
import { AI_SUBTITLE_ASR_VERSION, AI_SUBTITLE_TRANSLATION_VERSION } from './runtimeManifest'
import type { SubtitleCue } from './subtitleDocument'

const cueSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(),
  japanese: z.string().min(1).max(1800), chinese: z.string().min(1).max(3600).optional() }).strict()
const chunkSchema = z.object({ version: z.literal(1), index: z.number().int().nonnegative(),
  translated: z.boolean(), translationVersion: z.string().max(128).optional(), cues: z.array(cueSchema).max(1000) }).strict()
export interface SubtitleChunk { index: number; translated: boolean; cues: SubtitleCue[] }
export function subtitleCacheKey(source: PlaybackSource, audioIdentity: string): string {
  // Grant URLs are intentionally excluded. Local replacement and catalog/server identity invalidate caches.
  return createHash('sha256').update(JSON.stringify([source.identityKey, source.revision, source.target,
    source.fileIdentity ?? source.resumeKey, audioIdentity, AI_SUBTITLE_ASR_VERSION, 'ja'])).digest('hex')
}
export async function atomicWrite(filename: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temporary, filename) }
  finally { await fs.rm(temporary, { force: true }) }
}
export function createSubtitleCache(root: string, key: string, persist = true) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('字幕缓存身份无效')
  const directory = path.join(root, key)
  const memory = new Map<number, SubtitleChunk>()
  return {
    directory,
    async read(index: number): Promise<SubtitleChunk | null> {
      const entry = memory.get(index)
      if (entry) return structuredClone(entry)
      if (!persist) return null
      try {
        const file = path.join(directory, `${index}.json`)
        if ((await fs.stat(file)).size > 1024 * 1024) return null
        const parsed = chunkSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
        if (!parsed.success || parsed.data.index !== index || parsed.data.cues.some(cue => cue.end <= cue.start)) return null
        const chunk: SubtitleChunk = { index, translated: parsed.data.translated, cues: parsed.data.cues }
        if (parsed.data.translationVersion !== AI_SUBTITLE_TRANSLATION_VERSION) {
          chunk.translated = false; chunk.cues = chunk.cues.map(({ start, end, japanese }) => ({ start, end, japanese }))
        }
        memory.set(index, chunk)
        return structuredClone(chunk)
      } catch { return null }
    },
    async write(chunk: SubtitleChunk): Promise<void> {
      const parsed = chunkSchema.parse({ ...chunk, version: 1, translationVersion: AI_SUBTITLE_TRANSLATION_VERSION })
      if (persist) await atomicWrite(path.join(directory, `${chunk.index}.json`), JSON.stringify(parsed))
      memory.set(chunk.index, structuredClone(chunk))
    },
    async clear(): Promise<void> { memory.clear(); await fs.rm(directory, { recursive: true, force: true }) }
  }
}
