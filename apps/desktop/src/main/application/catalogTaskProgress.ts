import type { CatalogTaskSnapshot, CatalogTaskState } from '@shared/protocol/tasks'
import type { CatalogBackend } from './catalogBackend'

const TERMINAL_STATES = new Set<CatalogTaskState>([
  'succeeded',
  'failed',
  'cancelled',
  'needsInspection'
])

export const CATALOG_TASK_POLL_INTERVAL_MS = 2_000
export const CATALOG_TASK_POLL_MAX_BACKOFF_MS = 30_000

export function isTerminalCatalogTaskState(state: CatalogTaskState): boolean {
  return TERMINAL_STATES.has(state)
}

export type CatalogTaskProgressRejectReason =
  | 'stale-generation'
  | 'catalog-mismatch'
  | 'task-mismatch'
  | 'stale-revision'
  | 'stale-progress'
  | 'terminal-rewind'

export function decideCatalogTaskProgressApply(input: {
  current: CatalogTaskSnapshot | null
  incoming: CatalogTaskSnapshot
  requestGeneration: number
  currentGeneration: number
  expectedCatalogId?: string | null
  expectedTaskId?: string
}): { apply: true } | { apply: false; reason: CatalogTaskProgressRejectReason } {
  if (input.requestGeneration !== input.currentGeneration) {
    return { apply: false, reason: 'stale-generation' }
  }
  if (
    input.expectedCatalogId &&
    input.incoming.catalogId &&
    input.incoming.catalogId !== input.expectedCatalogId
  ) {
    return { apply: false, reason: 'catalog-mismatch' }
  }
  if (input.expectedTaskId && input.incoming.taskId !== input.expectedTaskId) {
    return { apply: false, reason: 'task-mismatch' }
  }
  const current = input.current
  if (!current) return { apply: true }
  if (input.incoming.taskRevision < current.taskRevision) {
    return { apply: false, reason: 'stale-revision' }
  }
  if (
    input.incoming.taskRevision === current.taskRevision &&
    input.incoming.progressSeq < current.progressSeq
  ) {
    return { apply: false, reason: 'stale-progress' }
  }
  if (
    isTerminalCatalogTaskState(current.state) &&
    !isTerminalCatalogTaskState(input.incoming.state)
  ) {
    return { apply: false, reason: 'terminal-rewind' }
  }
  return { apply: true }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof Error && /aborted|abort/i.test(error.message))
  )
}

function abortError(): Error {
  const error = new Error('任务已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

async function sleepOrAbort(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (!signal) {
    await sleep(ms)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort)
    void sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort)
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export async function waitForCatalogTask(options: {
  backend: Pick<CatalogBackend, 'tasks' | 'generation' | 'session'>
  taskId: string
  timeoutMs?: number
  intervalMs?: number
  maxBackoffMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  onApplied?: (snapshot: CatalogTaskSnapshot) => void
}): Promise<CatalogTaskSnapshot> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? CATALOG_TASK_POLL_INTERVAL_MS
  const maxBackoffMs = options.maxBackoffMs ?? CATALOG_TASK_POLL_MAX_BACKOFF_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  let current: CatalogTaskSnapshot | null = null
  let delayMs = 0
  let failureBackoffMs = intervalMs

  while (now() < deadline) {
    throwIfAborted(options.signal)
    if (delayMs > 0) {
      await sleepOrAbort(delayMs, sleep, options.signal)
    }
    const requestGeneration = options.backend.generation
    const expectedCatalogId = options.backend.session().catalogId
    let incoming: CatalogTaskSnapshot
    try {
      incoming = (await withAbort(
        options.backend.tasks.get({ taskId: options.taskId }, { signal: options.signal }),
        options.signal
      )) as CatalogTaskSnapshot
    } catch (error) {
      if (options.signal?.aborted) throw abortError()
      if (options.backend.generation !== requestGeneration) {
        delayMs = 0
        failureBackoffMs = intervalMs
        continue
      }
      if (now() >= deadline) throw error
      delayMs = isAbortError(error) ? 0 : failureBackoffMs
      if (!isAbortError(error)) {
        failureBackoffMs = Math.min(failureBackoffMs * 2, maxBackoffMs)
      }
      continue
    }
    const decision = decideCatalogTaskProgressApply({
      current,
      incoming,
      requestGeneration,
      currentGeneration: options.backend.generation,
      expectedCatalogId,
      expectedTaskId: options.taskId
    })
    if (options.backend.generation !== requestGeneration) {
      delayMs = 0
      failureBackoffMs = intervalMs
      continue
    }
    if (!decision.apply) {
      delayMs = intervalMs
      continue
    }
    current = incoming
    failureBackoffMs = intervalMs
    options.onApplied?.(incoming)
    if (isTerminalCatalogTaskState(incoming.state)) return incoming
    delayMs = intervalMs
  }
  throw new Error('任务超时')
}
