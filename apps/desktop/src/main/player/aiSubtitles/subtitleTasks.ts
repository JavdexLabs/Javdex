import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PlaybackTarget } from '@shared/desktop/playback'
import type { SubtitleTaskView, SubtitleTasksSnapshot } from '@shared/desktop/subtitleTasks'
import type { PlaybackSource } from '../playbackSource'
import { playbackTargetSchema } from '../playbackSchemas'
import { atomicWrite } from '../../utils/atomicWrite'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { createOfflineSubtitleInference } from './offlineInference'
import { createSubtitleCache, subtitleCacheKey } from './subtitleCache'
import { createSubtitleScheduler, type SubtitleSchedulerState } from './subtitleScheduler'
import { renderSubtitleAss, renderSubtitleSrt, type SubtitleCue } from './subtitleDocument'
import { publishSubtitleFile, subtitleOutputPath } from './subtitleFiles'

const jobSchema = z.object({
  id: z.string().uuid(), title: z.string(), target: playbackTargetSchema,
  resourceKey: z.string(), fileIdentity: z.string(), revision: z.string(),
  audioIndex: z.number().int().nonnegative(), output: z.enum(['bilingual', 'japanese']),
  asrVersion: z.string(), translationVersion: z.string(), duration: z.number().positive().max(604800),
  status: z.enum(['queued', 'running', 'paused', 'failed', 'saving', 'awaiting-save', 'completed', 'cancelled']),
  recognizedSeconds: z.number().nonnegative(), translatedSeconds: z.number().nonnegative(), error: z.string().nullable(),
  outputPath: z.string().nullable(), outputHash: z.string().nullable(), cacheKey: z.string().nullable()
}).strict()
type Job = z.infer<typeof jobSchema>
interface Dependencies {
  root: string
  cacheRoot: string
  resolve(target: PlaybackTarget): Promise<PlaybackSource>
  validate(source: PlaybackSource): Promise<void>
  runtime: { installed(): Promise<boolean>; paths(): AiRuntimePaths }
  acquireRuntime(): Promise<() => void>
  inference?: typeof createOfflineSubtitleInference
  saved?(source: PlaybackSource, filename: string): void
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const message = (error: unknown): string => error instanceof Error ? error.message : '字幕任务失败'
const modelIdentity = (paths: AiRuntimePaths): [string, string] => [paths.asrVersion ?? paths.kotoba, paths.translationVersion ?? paths.translationModel]

/** One device queue, independent from player/renderer lifetimes. Only local
 * resource identities are persisted; resolution and authorization run anew. */
export function createSubtitleTasks(deps: Dependencies) {
  const manifest = path.join(deps.root, 'tasks.json')
  const listeners = new Set<() => void>()
  const results = new Map<string, SubtitleCue[]>()
  const progress = new Map<string, SubtitleSchedulerState>()
  let jobs: Job[] = [], error: string | null = null, closed = false
  let writes = Promise.resolve(), mutation = Promise.resolve()
  let active: { job: Job; controller: AbortController; run: ReturnType<typeof createSubtitleScheduler> | null } | null = null
  let loop: Promise<void> | null = null
  let playing = false, priority: string | null = null, position = 0
  const ready = (async () => {
    try {
      const stat = await fs.stat(manifest)
      if (stat.size > 8 * 1024 * 1024) throw new Error('字幕任务清单过大')
      const parsed = z.object({ version: z.literal(1), jobs: z.array(jobSchema).max(10000) }).strict().parse(JSON.parse(await fs.readFile(manifest, 'utf8')))
      jobs = parsed.jobs.map(job => ['queued', 'running', 'saving'].includes(job.status)
        ? { ...job, status: 'paused', error: '应用已退出，请继续任务' } : job)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') error = '字幕任务清单无法读取，已保留原文件，请检查存储或恢复备份'
    }
    if (!error) {
      try {
        for (const job of jobs) {
          const root = path.resolve(deps.root), directory = path.resolve(root, job.id, 'work')
          if (path.dirname(path.dirname(directory)) !== root) throw new Error('字幕任务目录无效')
          await fs.rm(directory, { recursive: true, force: true })
        }
      } catch { error = '字幕临时音频无法清理，请检查任务目录权限后重新启动' }
    }
  })()
  const notify = (): void => { for (const listener of listeners) listener() }
  const persist = (): Promise<void> => {
    const body = JSON.stringify({ version: 1, jobs })
    const pending = writes.then(() => atomicWrite(manifest, body))
    writes = pending.catch(() => { error = '字幕任务状态无法保存，请检查磁盘空间及权限'; active?.controller.abort(); notify() })
    return pending
  }
  const view = (job: Job): SubtitleTaskView => ({ id: job.id, title: job.title, target: job.target, audioIndex: job.audioIndex,
    output: job.output, status: job.status, duration: job.duration, recognizedSeconds: job.recognizedSeconds,
    translatedSeconds: job.translatedSeconds, error: job.error, outputName: job.outputPath ? path.basename(job.outputPath) : null })
  const requireJob = (id: string): Job => {
    const job = jobs.find(job => job.id === id)
    if (!job) throw new Error('字幕任务不存在')
    return job
  }
  const checkpointRoot = (job: Job): string => path.join(deps.root, job.id, 'chunks')
  async function resolve(job: Job): Promise<PlaybackSource> {
    const source = await deps.resolve(job.target)
    if (source.mode !== 'local' || source.resumeKey !== job.resourceKey || source.fileIdentity !== job.fileIdentity || source.revision !== job.revision)
      throw new Error('影片资源或资料库已变化，请为当前资源重新创建任务')
    return source
  }
  async function loadCues(job: Job): Promise<SubtitleCue[]> {
    if (results.has(job.id)) return results.get(job.id)!
    if (!job.cacheKey) return []
    const cache = createSubtitleCache(checkpointRoot(job), job.cacheKey, true, job.translationVersion)
    const cues: SubtitleCue[] = []
    for (let index = 0; index < Math.ceil(job.duration / 30); index++) {
      const chunk = await cache.read(index)
      if (['completed', 'awaiting-save', 'saving'].includes(job.status) && (!chunk || job.output === 'bilingual' && !chunk.translated))
        throw new Error('任务中间结果缺失或已失效，请移除任务后重新生成；已保存的字幕文件保留')
      if (chunk) cues.push(...chunk.cues)
    }
    results.set(job.id, cues)
    return cues
  }
  async function save(job: Job, selected?: { filename: string; replace: boolean; srt?: boolean }): Promise<void> {
    const source = await resolve(job)
    const cues = await loadCues(job)
    const body = selected?.srt ? renderSubtitleSrt(cues, job.output) : renderSubtitleAss(cues, job.output)
    const filename = selected?.filename ?? job.outputPath ?? subtitleOutputPath(source.locator, job.output)
    const normalized = (file: string): string => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
    if (normalized(filename) === normalized(source.locator) || path.extname(filename).toLowerCase() !== (selected?.srt ? '.srt' : '.ass'))
      throw new Error('请选择正确扩展名的字幕文件，不能覆盖影片资源')
    await deps.validate(source)
    // Only record ownership after this task publishes the file. Matching
    // contents alone do not prove that a pre-existing subtitle belongs to it.
    await publishSubtitleFile(filename, body, selected?.replace ?? false)
    if (selected?.srt) return
    job.outputPath = filename; job.outputHash = hash(body); job.status = 'completed'; job.error = null
    await persist(); notify(); deps.saved?.(source, filename)
  }
  async function run(job: Job): Promise<void> {
    const owner = { job, controller: new AbortController(), run: null as ReturnType<typeof createSubtitleScheduler> | null }
    active = owner
    const signal = owner.controller.signal
    let engine: ReturnType<typeof createOfflineSubtitleInference> | undefined, release: (() => void) | undefined
    try {
      job.status = 'running'; job.error = null; await persist(); notify()
      const source = await resolve(job)
      if (!await deps.runtime.installed()) throw new Error('字幕模型或运行环境未准备好，请在模型设置中安装后继续')
      release = await deps.acquireRuntime()
      signal.throwIfAborted()
      const paths = deps.runtime.paths(), [asr, translation] = modelIdentity(paths)
      if (asr !== job.asrVersion || (job.output === 'bilingual' && translation !== job.translationVersion))
        throw new Error('模型配置已变化，请切回任务创建时的模型，或创建新任务')
      engine = (deps.inference ?? createOfflineSubtitleInference)(paths, path.join(deps.root, job.id, 'work'))
      const stream = await engine.probe(source.locator, job.audioIndex, signal)
      signal.throwIfAborted()
      job.cacheKey = subtitleCacheKey(source, stream.identity, asr)
      await persist()
      const cache = createSubtitleCache(checkpointRoot(job), job.cacheKey, true, translation)
      const previous = createSubtitleCache(deps.cacheRoot, job.cacheKey, true, translation)
      const siblings = jobs.filter(other => other.id !== job.id && other.cacheKey === job.cacheKey)
        .sort((a, b) => Number(b.translationVersion === translation) - Number(a.translationVersion === translation))
        .map(other => createSubtitleCache(checkpointRoot(other), job.cacheKey!, true, translation))
      await new Promise<void>((done, reject) => {
        const aborted = (): void => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        owner.run = createSubtitleScheduler(job.duration, {
          read: async index => {
            const own = await cache.read(index)
            if (own) return own
            let old = await previous.read(index)
            for (const sibling of siblings) { if (old) break; old = await sibling.read(index) }
            if (old) await cache.write(old)
            return old
          },
          write: chunk => cache.write(chunk),
          recognize: async (start, end, chunkSignal) => {
            await deps.validate(source); chunkSignal.throwIfAborted()
            return engine!.recognize(source.locator, stream.index, start, end, chunkSignal)
          },
          translate: (cues, chunkSignal, updated) => engine!.translate(cues, chunkSignal, updated),
          changed: state => {
            if (signal.aborted) return
            results.set(job.id, state.cues); progress.set(job.id, state)
            job.recognizedSeconds = state.recognizedSeconds; job.translatedSeconds = state.translatedSeconds
            job.error = state.error; notify()
            if (state.finished) {
              signal.removeEventListener('abort', aborted)
              if (state.error) reject(new Error(state.error))
              else done()
            }
          }
        }, job.output === 'bilingual')
        if (priority === job.id) owner.run.position(position)
        owner.run.start()
        if (signal.aborted) aborted()
      })
      signal.throwIfAborted()
      job.status = 'saving'; await persist(); notify()
      signal.throwIfAborted()
      try { await save(job) }
      catch (cause) { job.status = 'awaiting-save'; job.error = (cause as NodeJS.ErrnoException).code === 'EEXIST'
        ? '同名字幕已存在，请另存或在保存对话框中确认替换' : `生成完成，等待保存：${message(cause)}` }
    } catch (cause) {
      if (!signal.aborted) { job.status = 'failed'; job.error = message(cause) }
      else if (job.status === 'running' || job.status === 'saving') job.status = closed ? 'paused' : 'queued'
    } finally {
      await owner.run?.stop().catch(() => {})
      await engine?.close().catch(() => {})
      release?.()
      if (active === owner) active = null
      await persist().catch(() => {}); notify()
    }
  }
  function kick(): void {
    if (loop || closed || error) return
    loop = (async () => {
      await ready
      if (!closed && !error) {
        const next = jobs.find(job => job.id === priority && job.status === 'queued')
          ?? (!playing ? jobs.find(job => job.status === 'queued') : undefined)
        if (next) await run(next)
      }
    })().catch(cause => { error = message(cause); notify() }).finally(() => {
      loop = null
      if (jobs.some(job => job.status === 'queued' && (!playing || job.id === priority))) kick()
    })
  }
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutation.then(async () => { await ready; if (closed) throw new Error('字幕任务服务已关闭'); if (error) throw new Error(error); return operation() })
    mutation = next.then(() => {}, () => {})
    return next
  }
  return {
    ready,
    async snapshot(): Promise<SubtitleTasksSnapshot> { await ready; return { tasks: jobs.map(view), error } },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    state(id: string) { const job = jobs.find(job => job.id === id); return job ? { job: view(job), progress: progress.get(id), cues: results.get(id) ?? [] } : null },
    async destination(id: string): Promise<string> {
      await ready
      const job = requireJob(id), source = await resolve(job)
      return job.outputPath ?? subtitleOutputPath(source.locator, job.output)
    },
    enqueue(source: PlaybackSource, audioIndex: number, duration: number, output: 'bilingual' | 'japanese' = 'bilingual'): Promise<string> {
      return exclusive(async () => {
        if (source.mode !== 'local' || !source.fileIdentity) throw new Error('后台字幕任务目前仅支持本机资源')
        await deps.validate(source)
        if (!await deps.runtime.installed()) throw new Error('请先准备字幕模型与运行环境')
        const [asrVersion, translationVersion] = modelIdentity(deps.runtime.paths())
        const old = jobs.find(job => job.resourceKey === source.resumeKey && job.audioIndex === audioIndex
          && job.output === output && job.asrVersion === asrVersion && (output === 'japanese' || job.translationVersion === translationVersion))
        if (old) {
          await loadCues(old)
          if (!['completed', 'awaiting-save', 'running', 'saving'].includes(old.status)) old.status = 'queued'
          await persist(); notify(); kick(); return old.id
        }
        const job: Job = { id: randomUUID(), title: source.title, target: source.target, resourceKey: source.resumeKey,
          revision: source.revision, fileIdentity: source.fileIdentity, audioIndex, output, asrVersion, translationVersion,
          duration, status: 'queued', recognizedSeconds: 0, translatedSeconds: 0, error: null, outputPath: subtitleOutputPath(source.locator, output), outputHash: null, cacheKey: null }
        jobSchema.parse(job); jobs.push(job); await persist(); notify(); kick(); return job.id
      })
    },
    observe(isPlaying: boolean, selectedJob: string | null, at: number): void {
      const changed = playing !== isPlaying || priority !== selectedJob
      playing = isPlaying; priority = selectedJob; position = at
      if (active && playing && active.job.id !== priority) active.controller.abort()
      else if (active && active.job.id === priority) active.run?.position(at)
      if (changed) kick()
    },
    action(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry-save' | 'remove' | 'delete-output', selected?: { filename: string; replace: boolean; srt?: boolean }): Promise<void> {
      return exclusive(async () => {
        const job = requireJob(id)
        if (action === 'pause' && !['queued', 'running'].includes(job.status)) return
        if (action === 'cancel' && ['completed', 'saving'].includes(job.status)) return
        if (action === 'pause' || action === 'cancel' || action === 'remove' || action === 'delete-output') {
          if (active?.job === job) { job.status = 'paused'; active.controller.abort(); await loop }
          if (action === 'pause') job.status = 'paused'
          if (action === 'cancel') job.status = 'cancelled'
          if (action === 'remove') {
            jobs = jobs.filter(value => value !== job); results.delete(id); progress.delete(id)
            // Remove only this UUID's private checkpoint directory after the
            // manifest commits. Never follow outputPath into the media folder.
            await persist()
            const root = path.resolve(deps.root), directory = path.resolve(root, job.id)
            if (path.dirname(directory) !== root) throw new Error('字幕任务目录无效')
            await fs.rm(directory, { recursive: true, force: true })
          }
          if (action === 'delete-output') {
            await resolve(job)
            if (!job.outputPath || !job.outputHash) throw new Error('没有已保存的字幕')
            const body = await fs.readFile(job.outputPath, 'utf8')
            if (hash(body) !== job.outputHash) throw new Error('字幕已被外部修改，为避免误删，请在文件管理器中处理')
            await fs.unlink(job.outputPath)
            job.outputPath = null; job.outputHash = null; job.status = 'awaiting-save'; job.error = '已删除生成文件，中间结果保留'
          }
        } else if (action === 'resume') {
          if (!['completed', 'awaiting-save', 'saving', 'running'].includes(job.status)) { job.status = 'queued'; job.error = null }
        } else {
          if (!['completed', 'awaiting-save'].includes(job.status)) throw new Error('请先完成生成')
          await save(job, selected)
        }
        await persist(); notify(); kick()
      })
    },
    async close(): Promise<void> {
      closed = true; active?.controller.abort()
      await mutation; await loop; await ready
      if (!error) { for (const job of jobs) if (job.status === 'queued') job.status = 'paused'; await persist().catch(() => {}) }
      await writes
    }
  }
}
export type SubtitleTasks = ReturnType<typeof createSubtitleTasks>
