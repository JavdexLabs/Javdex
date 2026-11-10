import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { SubtitleFilesSnapshot, SubtitleFileView } from '@shared/desktop/subtitleTasks'
import type { NativePlayback } from './nativePlayback'
import type { PlaybackSource } from './playbackSource'
import { atomicWrite } from '../utils/atomicWrite'
import { discoverSubtitleFiles } from './aiSubtitles/subtitleFiles'

const choiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('file'), file: z.string() }),
  z.object({ kind: z.literal('track'), id: z.number(), title: z.string().nullable(), language: z.string().nullable() })
])
type Choice = z.infer<typeof choiceSchema>
const entrySchema = z.object({ files: z.array(z.string()).max(128), choice: choiceSchema.optional() })
interface Dependencies {
  filename: string
  native: NativePlayback
  playback(): PlaybackSnapshot | null
  source(id: string): PlaybackSource
  validate(source: PlaybackSource): Promise<void>
  add(id: string, filename: string, select: boolean): void
  select(id: string, track: number | null): void
}
export function createSubtitleDiscovery(deps: Dependencies) {
  let entries: Record<string, z.infer<typeof entrySchema>> = Object.create(null)
  let storageError: string | null = null, notice: string | null = null
  let session: string | null = null, intent = 0, loading = false, closed = false
  let explicitSession: string | null = null
  let loaded = new Set<string>()
  let pending: { choice: Choice; intent: number; deadline: number } | null = null
  let writes = Promise.resolve(), refreshPromise: Promise<void> | null = null
  const ready = (async () => {
    try {
      if ((await fs.stat(deps.filename)).size > 8 * 1024 * 1024) throw new Error('字幕选择记录过大')
      entries = z.record(z.string(), entrySchema).parse(JSON.parse(await fs.readFile(deps.filename, 'utf8')))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') storageError = '字幕选择记录无法读取，原文件已保留'
    }
  })()
  const persist = (): Promise<void> => {
    if (storageError) return Promise.resolve()
    const body = JSON.stringify(entries)
    writes = writes.then(() => atomicWrite(deps.filename, body)).catch(() => { storageError = '字幕选择无法保存，请检查磁盘权限和空间' })
    return writes
  }
  const tracks = (): Array<{ id: number; type: string; 'external-filename'?: string; title?: string; lang?: string }> => {
    try { return JSON.parse(deps.native.read()['track-list'] ?? '[]') } catch { return [] }
  }
  const normalize = (file: string): string => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  const unique = (files: string[]): string[] => [...new Map(files.map(file => [normalize(file), file])).values()]
  async function fileError(file: string): Promise<string | null> {
    if (!path.isAbsolute(file) || !['.srt', '.ass'].includes(path.extname(file).toLowerCase())) return '仅支持本机 SRT / ASS 字幕文件'
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) return '不是字幕文件'
      if (stat.size > 32 * 1024 * 1024) return '字幕文件超过 32 MiB'
      await fs.access(file, fs.constants.R_OK)
      return null
    } catch { return '文件不存在或无法读取' }
  }
  async function files(source: PlaybackSource): Promise<SubtitleFilesSnapshot> {
    if (closed || source.mode !== 'local') throw new Error('字幕文件管理目前仅支持本机资源')
    await ready; await deps.validate(source)
    let found: string[] = [], error = storageError
    try { found = await discoverSubtitleFiles(source.locator) }
    catch { error = error ?? '无法读取影片目录，请检查目录是否可访问' }
    const linked = entries[source.resumeKey]?.files ?? []
    const linkedKeys = new Set(linked.map(normalize))
    const candidates = unique([...linked, ...found])
    if (candidates.length > 128) error = error ?? '最多显示并加载 128 个字幕文件'
    const result: SubtitleFileView[] = []
    for (const file of candidates.slice(0, 128)) {
      const isLinked = linkedKeys.has(normalize(file))
      let unavailable = await fileError(file)
      if (!unavailable && !isLinked) {
        try {
          if (normalize(path.dirname(await fs.realpath(file))) !== normalize(path.dirname(source.locator))) unavailable = '字幕不在影片目录内'
        } catch { unavailable = '文件不存在或无法读取' }
      }
      result.push({ path: file, name: path.basename(file), source: isLinked ? 'linked' : 'directory', available: !unavailable, error: unavailable })
    }
    await deps.validate(source)
    if (closed) throw new Error('字幕管理已关闭')
    return { files: result, error }
  }
  async function associateFiles(source: PlaybackSource, filenames: string[]): Promise<void> {
    if (closed || source.mode !== 'local') throw new Error('字幕文件管理目前仅支持本机资源')
    await ready
    if (storageError) throw new Error(storageError)
    const added = unique(filenames)
    if (added.length > 128) throw new Error('每次最多关联 128 个字幕文件')
    for (const file of added) {
      const error = await fileError(file)
      if (error) throw new Error(`${path.basename(file)}：${error}`)
    }
    // Recheck after file inspection/native selection; never attach to a changed resource.
    await deps.validate(source)
    if (closed) throw new Error('字幕管理已关闭')
    const previous = entries[source.resumeKey]
    const combined = unique([...(previous?.files ?? []), ...added])
    if (combined.length > 128) throw new Error('每个影片资源最多关联 128 个字幕文件')
    const next = { ...previous, files: combined }
    entries[source.resumeKey] = next
    await persist()
    if (storageError) {
      if (entries[source.resumeKey] === next) {
        if (previous) entries[source.resumeKey] = previous
        else delete entries[source.resumeKey]
      }
      throw new Error(storageError)
    }
  }
  async function refresh(): Promise<void> {
    const playback = deps.playback()
    if (!playback || closed) return
    const id = playback.sessionId, source = deps.source(id), epoch = intent
    if (source.mode !== 'local') return
    const valid = (): boolean => !closed && deps.playback()?.sessionId === id
    const snapshot = await files(source)
    const entry = entries[source.resumeKey]
    const candidates = snapshot.files.filter(file => file.available).map(file => file.path)
    const missing = snapshot.files.filter(file => !file.available).map(file => file.name)
    for (const file of candidates) {
      if (!valid()) return
      if (loaded.has(normalize(file))) continue
      try {
        await deps.validate(source)
        if (!valid()) return
        deps.add(id, file, false); loaded.add(normalize(file))
      } catch { missing.push(path.basename(file)) }
    }
    if (!valid()) return
    notice = missing.length ? `部分字幕不可用：${missing.join('、')}` : snapshot.error
    if (epoch !== intent || explicitSession === id) return
    // Only restore once. Explicit commands invalidate the pending selection.
    if (entry?.choice) pending = { choice: entry.choice, intent: epoch, deadline: Date.now() + 5000 }
    else if (!playback.tracks.some(track => track.type === 'sub' && track.selected)) {
      const preferred = candidates.find(file => /\.(zh(?:-[a-z]+)?|chs|cht|chi|zho)(\.|$)/i.test(path.basename(file))) ?? candidates[0]
      if (preferred) pending = { choice: { kind: 'file', file: preferred }, intent: epoch, deadline: Date.now() + 5000 }
    }
  }
  function requestRefresh(): Promise<void> {
    if (refreshPromise) return refreshPromise
    refreshPromise = refresh().catch(cause => { notice = cause instanceof Error ? cause.message : '字幕发现失败' })
      .finally(() => { refreshPromise = null })
    return refreshPromise
  }
  function remember(choice: Choice, added?: string): void {
    intent++; pending = null
    const playback = deps.playback()
    if (!playback || closed) return
    explicitSession = playback.sessionId
    const source = deps.source(playback.sessionId)
    if (source.mode !== 'local') return
    void ready.then(() => {
      const previous = entries[source.resumeKey] ?? { files: [] }
      entries[source.resumeKey] = { files: unique([...previous.files, ...(added ? [added] : [])]).slice(-128), choice }
      void persist()
    })
  }
  return {
    refresh: requestRefresh,
    files,
    associateFiles,
    associate: (source: PlaybackSource, file: string) => associateFiles(source, [file]),
    notice: () => notice ?? storageError,
    selected(id: number | null): void {
      if (id === null) { remember({ kind: 'off' }); return }
      const track = tracks().find(track => track.type === 'sub' && track.id === id)
      if (!track || id === Number.MAX_SAFE_INTEGER) { intent++; pending = null; explicitSession = deps.playback()?.sessionId ?? null; return }
      const file = track['external-filename']
      remember(file ? { kind: 'file', file } : { kind: 'track', id, title: track.title ?? null, language: track.lang ?? null })
    },
    manual(file: string): void { loaded.add(normalize(file)); remember({ kind: 'file', file }, file) },
    suppressSelection(): void { intent++; pending = null; explicitSession = deps.playback()?.sessionId ?? null },
    tick(state: PlaybackSnapshot | null): void {
      if (closed) return
      if (state?.sessionId !== session) { session = state?.sessionId ?? null; intent++; loading = false; loaded = new Set(); pending = null; notice = null }
      if (!state || state.source !== 'local' || state.phase === 'opening' || state.phase === 'error') return
      if (!loading && !refreshPromise) { loading = true; void requestRefresh() }
      if (!pending || pending.intent !== intent) return
      const choice = pending.choice
      const match = choice.kind === 'off' ? null : tracks().find(track => track.type === 'sub' && (choice.kind === 'file'
        ? track['external-filename'] && normalize(track['external-filename']) === normalize(choice.file)
        : track.id === choice.id && (track.title ?? null) === choice.title && (track.lang ?? null) === choice.language))
      if (choice.kind === 'off' || match) { pending = null; intent++; deps.select(state.sessionId, match?.id ?? null) }
      else if (Date.now() > pending.deadline) { pending = null; notice = '上次选择的字幕不可用，请重新选择' }
    },
    async close(): Promise<void> { closed = true; await ready; await refreshPromise; await writes }
  }
}
