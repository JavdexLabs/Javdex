import type { SubtitleChunk } from './subtitleCache'
import { SUBTITLE_CHUNK_SECONDS, type SubtitleCue } from './subtitleDocument'

interface Dependencies {
  read(index: number): Promise<SubtitleChunk | null>
  write(chunk: SubtitleChunk): Promise<void>
  recognize(start: number, end: number, signal: AbortSignal): Promise<SubtitleCue[]>
  translate(cues: SubtitleCue[], signal: AbortSignal, updated: (cues: SubtitleCue[]) => Promise<void>): Promise<SubtitleCue[]>
  changed(state: SubtitleSchedulerState): void
}
export interface SubtitleSchedulerState {
  phase: 'recognizing' | 'translating' | 'ready' | 'error'
  activeStart: number | null
  recognizedSeconds: number
  translatedSeconds: number
  error: string | null
  cues: SubtitleCue[]
}
/** Exactly one inference task. A seek changes priority and invalidates publication from the old task. */
export function createSubtitleScheduler(duration: number, deps: Dependencies) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 604800) throw new Error('影片时长暂不可用')
  const count = Math.ceil(duration / SUBTITLE_CHUNK_SECONDS)
  const chunks = new Map<number, SubtitleChunk>()
  const attempted = new Set<number>()
  let position = 0, stopped = true, loop: Promise<void> | null = null
  let active: { index: number; controller: AbortController } | null = null
  let error: string | null = null
  const publish = (phase: SubtitleSchedulerState['phase']): void => {
    if (stopped) return
    const seconds = (index: number): number => Math.min(SUBTITLE_CHUNK_SECONDS, duration - index * SUBTITLE_CHUNK_SECONDS)
    deps.changed({ phase, activeStart: active ? active.index * SUBTITLE_CHUNK_SECONDS : null, error,
      recognizedSeconds: [...chunks.keys()].reduce((sum, index) => sum + seconds(index), 0),
      translatedSeconds: [...chunks.values()].filter(chunk => chunk.translated).reduce((sum, chunk) => sum + seconds(chunk.index), 0),
      cues: [...chunks.values()].flatMap(chunk => chunk.cues) })
  }
  const next = (): number | null => {
    const current = Math.min(count - 1, Math.max(0, Math.floor(position / SUBTITLE_CHUNK_SECONDS)))
    for (let offset = 0; offset < count; offset++) {
      const index = (current + offset) % count
      if (!attempted.has(index)) return index
    }
    return null
  }
  async function run(): Promise<void> {
    while (!stopped) {
      const index = next()
      if (index === null) { active = null; publish(error ? 'error' : 'ready'); return }
      const task = { index, controller: new AbortController() }
      active = task
      const signal = task.controller.signal
      try {
        let chunk = chunks.get(index) ?? await deps.read(index)
        signal.throwIfAborted()
        if (!chunk) {
          publish('recognizing')
          chunk = { index, translated: false, cues: await deps.recognize(index * SUBTITLE_CHUNK_SECONDS, Math.min(duration, (index + 1) * SUBTITLE_CHUNK_SECONDS), signal) }
          signal.throwIfAborted()
          await deps.write(chunk)
        }
        signal.throwIfAborted(); chunks.set(index, chunk)
        if (!chunk.translated) {
          publish('translating')
          const cues = await deps.translate(chunk.cues, signal, async cues => {
            signal.throwIfAborted()
            const partial = { index, translated: false, cues }
            await deps.write(partial)
            signal.throwIfAborted(); chunks.set(index, partial); publish('translating')
          })
          signal.throwIfAborted()
          chunk = { index, translated: true, cues }
          await deps.write(chunk)
          signal.throwIfAborted(); chunks.set(index, chunk)
        }
        attempted.add(index); publish('ready')
      } catch {
        if (!signal.aborted && !stopped) {
          error = '部分字幕生成失败，可重试；已生成字幕保留，播放不受影响'
          attempted.add(index); publish('error')
        }
      } finally { if (active === task) active = null }
    }
  }
  function kick(): void {
    if (stopped || loop || next() === null) return
    loop = run().finally(() => { loop = null; if (!stopped && next() !== null) kick() })
  }
  return {
    start(): void { stopped = false; kick() },
    position(value: number): void {
      if (!Number.isFinite(value)) return
      const jumped = Math.abs(value - position) > 5
      position = Math.max(0, Math.min(duration, value))
      const current = Math.min(count - 1, Math.floor(position / SUBTITLE_CHUNK_SECONDS))
      // Normal clock progression must not repeatedly cancel useful read-ahead work.
      if (active && !attempted.has(current) && active.index !== current && (jumped || Math.abs(active.index - current) > 2)) active.controller.abort()
      kick()
    },
    retry(): void { error = null; for (const index of attempted) if (!chunks.get(index)?.translated) attempted.delete(index); kick() },
    stop(): Promise<void> { stopped = true; active?.controller.abort(); return loop ?? Promise.resolve() }
  }
}
