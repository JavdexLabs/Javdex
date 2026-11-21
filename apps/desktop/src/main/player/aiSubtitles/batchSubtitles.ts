import path from 'node:path'
import { createHash } from 'node:crypto'
import type { BatchSubtitleItem, BatchSubtitlePreview, BatchSubtitleResult, SubtitleOutput } from '@shared/desktop/subtitleTasks'
import type { CatalogBackend } from '../../application/catalogBackend'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { playbackCatalogKey, type createPlaybackSourceResolver, type PlaybackSource } from '../playbackSource'
import type { PlaybackTarget } from '@shared/desktop/playback'
import { inspectSubtitleMedia } from './offlineInference'
import { inspectSubtitleOutput, inspectSubtitleOutputs, subtitleOutputPath } from './subtitleFiles'
import type { SubtitleTasks } from './subtitleTasks'

interface Dependencies {
  backend: CatalogBackend
  resolver: ReturnType<typeof createPlaybackSourceResolver>
  queue: Pick<SubtitleTasks, 'matchingJobs' | 'enqueueBatchItem'>
  paths(): AiRuntimePaths
  acquire(): Promise<() => void>
  inspectMedia?: typeof inspectSubtitleMedia
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const reason = (error: unknown): string => error instanceof Error ? error.message : '读取影片失败'

export function suggestedSubtitleAudio(audio: BatchSubtitlePreview['audio']): number | null {
  if (audio.length === 1) return audio[0].index
  const japanese = audio.filter(track => /^(ja|jpn)(-|$)/i.test(track.language))
  return japanese.length === 1 ? japanese[0].index : null
}

export function createBatchSubtitles({ backend, resolver, queue, paths, acquire, inspectMedia = inspectSubtitleMedia }: Dependencies) {
  function context(): string {
    if (backend.mode !== 'local') throw new Error('批量字幕仅支持本机资料库和本机挂载目录')
    const runtime = paths()
    return digest(JSON.stringify([playbackCatalogKey(backend), runtime.asrVersion ?? runtime.kotoba, runtime.translationVersion ?? runtime.translationModel]))
  }
  function validateContext(expected: string): void {
    if (expected !== context()) throw new Error('资料库或模型已切换，请重新检查所选影片')
  }
  async function localSource(expected: string, target: PlaybackTarget): Promise<PlaybackSource> {
    validateContext(expected)
    const source = await resolver.resolve(target)
    if (source.mode !== 'local') {
      resolver.release(source)
      throw new Error('批量字幕仅支持本机资料库')
    }
    validateContext(expected)
    return source
  }
  // A cancelled dialog can still have one IPC in flight. Bound ffprobe across dialogs too.
  let pending = Promise.resolve()
  function withMedia<T>(source: PlaybackSource, expected: string, onInspected: (media: Awaited<ReturnType<typeof inspectSubtitleMedia>>) => Promise<T> | T) {
    const next = pending.then(async () => {
      validateContext(expected)
      const release = await acquire()
      try {
        validateContext(expected)
        const info = await inspectMedia(paths(), source.locator, AbortSignal.timeout(35000))
        await resolver.validate(source)
        validateContext(expected)
        return await onInspected(info)
      } finally { release() }
    })
    pending = next.then(() => {}, () => {})
    return next
  }
  async function readVideo(libraryId: number, videoId: number) {
    const video = await backend.queries.getVideo({ scope: { kind: 'library', libraryId }, videoId })
    if (!video || video.id !== videoId) throw new Error('影片已移出此媒体库')
    return video
  }
  return {
    async start(): Promise<string> {
      if (backend.mode !== 'local') throw new Error('批量字幕仅支持本机资料库和本机挂载目录')
      const release = await acquire()
      try { return context() } finally { release() }
    },
    async preview(expected: string, libraryId: number, videoId: number, resourceId: number | null): Promise<BatchSubtitlePreview> {
      validateContext(expected)
      const row: BatchSubtitlePreview = { videoId, code: `影片 #${videoId}`, resources: [], resourceId: null,
        signature: '', audio: [], suggestedAudio: null, existingFiles: {}, jobs: [] }
      try {
        const video = await readVideo(libraryId, videoId)
        row.code = video.code
        const sources = new Map<number, PlaybackSource>()
        for (const resource of video.resources) {
          if (resource.library_id !== libraryId || resource.kind !== 'local') continue
          const option: BatchSubtitlePreview['resources'][number] = { id: resource.id, name: path.basename(resource.display_locator), primary: Boolean(resource.is_primary) }
          try {
            const source = await localSource(expected, { libraryId, videoId, resourceId: resource.id })
            option.name = path.basename(source.locator)
            sources.set(resource.id, source)
          } catch (cause) { option.error = reason(cause) }
          row.resources.push(option)
        }
        const allowed = row.resources.filter(resource => !resource.error)
        const chosen = resourceId ?? allowed.find(resource => resource.primary)?.id ?? (allowed.length === 1 ? allowed[0].id : null)
        const source = chosen == null ? null : sources.get(chosen)
        if (!allowed.length) throw new Error(row.resources[0]?.error ?? '没有本地视频文件（STRM 和外链不支持后台生成）')
        if (resourceId != null && !source) throw new Error('所选文件已不可用，请重新选择')
        if (source) {
          row.resourceId = source.target.resourceId
          row.signature = source.resumeKey
          row.existingFiles = await inspectSubtitleOutputs(source.locator)
          row.jobs = await queue.matchingJobs(source)
          row.audio = await withMedia(source, expected, media => media.audio)
          row.suggestedAudio = suggestedSubtitleAudio(row.audio)
        }
      } catch (cause) { row.error = reason(cause) }
      validateContext(expected)
      return row
    },
    async submit(expected: string, libraryId: number, output: SubtitleOutput, items: BatchSubtitleItem[]): Promise<BatchSubtitleResult[]> {
      const results: BatchSubtitleResult[] = []
      for (const item of items) {
        const { videoId, resourceId } = item
        try {
          const source = await localSource(expected, { libraryId, videoId, resourceId })
          if (source.resumeKey !== item.signature) throw new Error('影片文件已变化，请重新检查')
          const file = await inspectSubtitleOutput(subtitleOutputPath(source.locator, output))
          if (item.replaceRevision && item.replaceRevision !== file?.revision) throw new Error('原字幕已变化，请重新检查')
          if (file && !item.replaceRevision) {
            results.push({ videoId, outcome: 'skipped', message: '同种 AI 字幕已存在' })
            continue
          }
          const video = await readVideo(libraryId, videoId)
          const { outcome, message } = await withMedia(source, expected, media => {
            if (!media.audio.some(track => track.index === item.audioIndex)) throw new Error('所选音轨已变化，请重新检查')
            const title = `${video.code} · ${path.basename(source.locator)}`
            return queue.enqueueBatchItem(source, item.audioIndex, media.duration, output, title, item.resumeId, item.replaceRevision)
          })
          results.push({ videoId, outcome, message })
        } catch (cause) { results.push({ videoId, outcome: 'failed', message: reason(cause) }) }
      }
      return results
    }
  }
}
