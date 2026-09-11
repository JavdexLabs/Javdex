import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ActressBatchScrapeRequest, VideoBatchScrapeRequest } from '@shared/scrapeTypes'
import type { BatchLogEntry, BatchProgress } from '@shared/batchScrapeTypes'
import { readTestUserDataPath } from '@shared/appIdentity'

export type BatchScrapeJobKind = 'video' | 'actress'

export interface BatchScrapeJobTarget {
  id: number
  label: string
}

export interface PersistedBatchScrapeJob {
  jobId: string
  kind: BatchScrapeJobKind
  request: VideoBatchScrapeRequest | ActressBatchScrapeRequest
  targets: BatchScrapeJobTarget[]
  nextIndex: number
  success: number
  pending: number
  failed: number
  logs: BatchLogEntry[]
  total: number
  status: 'running' | 'paused'
  updatedAt: string
}

let cache: PersistedBatchScrapeJob | null | undefined
let manifest: { file: string; digest: string } | null = null

type JobDefinition = Pick<PersistedBatchScrapeJob, 'jobId' | 'kind' | 'request' | 'targets'>

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function pruneManifests(keep?: string): void {
  const directory = path.dirname(jobFilePath())
  // Called only after a committed pointer change/removal, never after an uncertain write.
  try {
    for (const file of fs.readdirSync(directory)) {
      if (file !== keep && /^batch-scrape-targets-[a-f0-9]{64}\.json$/.test(file)) {
        try { fs.unlinkSync(path.join(directory, file)) }
        catch (error) { console.error('Failed to remove unused batch manifest:', error) }
      }
    }
  } catch (error) { console.error('Failed to list unused batch manifests:', error) }
}

function atomicWrite(file: string, body: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx')
    fs.writeFileSync(fd, body, 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
    syncDirectory(path.dirname(file))
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function jobFilePath(): string {
  const userData = app?.getPath ? app.getPath('userData') : readTestUserDataPath()
  if (!userData) throw new Error('Electron app userData path is unavailable')
  return path.join(userData, 'batch-scrape-job.json')
}

function readJobFile(): PersistedBatchScrapeJob | null {
  const file = jobFilePath()
  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf-8')
    let parsed = JSON.parse(raw) as Partial<PersistedBatchScrapeJob> & { formatVersion?: number; manifestFile?: string; manifestSha256?: string }
    let loadedManifest: typeof manifest = null
    if (parsed.formatVersion !== undefined) {
      if (parsed.formatVersion !== 2 || typeof parsed.manifestSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(parsed.manifestSha256) ||
          parsed.manifestFile !== `batch-scrape-targets-${parsed.manifestSha256}.json`) {
        throw new Error('Invalid batch checkpoint manifest reference')
      }
      const definitionRaw = fs.readFileSync(path.join(path.dirname(file), parsed.manifestFile), 'utf-8')
      if (createHash('sha256').update(definitionRaw).digest('hex') !== parsed.manifestSha256) {
        throw new Error('Batch checkpoint manifest integrity check failed')
      }
      const definition = JSON.parse(definitionRaw) as JobDefinition
      if (definition.jobId !== parsed.jobId || definition.kind !== parsed.kind) throw new Error('Batch checkpoint identity mismatch')
      loadedManifest = { file: parsed.manifestFile, digest: parsed.manifestSha256 }
      parsed = { ...parsed, request: definition.request, targets: definition.targets }
    }
    if (
      (parsed.kind !== 'video' && parsed.kind !== 'actress') ||
      !parsed.request ||
      !Array.isArray(parsed.targets) ||
      typeof parsed.nextIndex !== 'number' ||
      typeof parsed.success !== 'number' ||
      typeof parsed.failed !== 'number' ||
      !Array.isArray(parsed.logs) ||
      typeof parsed.total !== 'number'
    ) {
      throw new Error('Invalid batch checkpoint contents')
    }
    if (parsed.targets.some(target => !target || !Number.isSafeInteger(target.id) || target.id <= 0 || typeof target.label !== 'string') ||
        ![parsed.nextIndex, parsed.success, parsed.failed, parsed.total, parsed.pending ?? 0]
          .every(value => Number.isSafeInteger(value) && value! >= 0) ||
        parsed.total !== parsed.targets.length || parsed.nextIndex > parsed.total) {
      throw new Error('Invalid batch checkpoint target or cursor')
    }
    manifest = loadedManifest
    const updatedAt =
      typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
    const legacyJobId = `legacy-${parsed.kind}-${createHash('sha256')
      .update(raw)
      .digest('hex')
      .slice(0, 16)}`
    return {
      jobId:
        typeof parsed.jobId === 'string' && parsed.jobId.trim()
          ? parsed.jobId.trim()
          : legacyJobId,
      kind: parsed.kind,
      request: parsed.request as VideoBatchScrapeRequest | ActressBatchScrapeRequest,
      targets: parsed.targets as BatchScrapeJobTarget[],
      nextIndex: Math.max(0, Math.floor(parsed.nextIndex)),
      success: Math.max(0, Math.floor(parsed.success)),
      pending:
        typeof parsed.pending === 'number' ? Math.max(0, Math.floor(parsed.pending)) : 0,
      failed: Math.max(0, Math.floor(parsed.failed)),
      logs: parsed.logs as BatchLogEntry[],
      total: Math.max(0, Math.floor(parsed.total)),
      status: parsed.status === 'running' ? 'running' : 'paused',
      updatedAt
    }
  } catch (cause) {
    throw new Error('无法读取批量任务检查点，请保留任务文件后检查原因', { cause })
  }
}

function persistProgress(job: PersistedBatchScrapeJob, definition: { file: string; digest: string }): void {
  const { request: _request, targets: _targets, ...progress } = job
  try {
    atomicWrite(jobFilePath(), JSON.stringify({ ...progress, formatVersion: 2,
      manifestFile: definition.file, manifestSha256: definition.digest }))
  } catch (error) {
    resetBatchScrapeJobCache()
    throw error
  }
  cache = job
  manifest = definition
}

export function loadBatchScrapeJob(): PersistedBatchScrapeJob | null {
  if (cache !== undefined) return cache
  cache = readJobFile()
  return cache
}

export function saveBatchScrapeJob(job: PersistedBatchScrapeJob): void {
  const definition: JobDefinition = { jobId: job.jobId, kind: job.kind, request: job.request, targets: job.targets }
  const body = JSON.stringify(definition)
  const digest = createHash('sha256').update(body).digest('hex')
  const file = `batch-scrape-targets-${digest}.json`
  atomicWrite(path.join(path.dirname(jobFilePath()), file), body)
  persistProgress({ ...job, updatedAt: new Date().toISOString() }, { file, digest })
  pruneManifests(file)
}

/** Progress-only saves keep the frozen definition; scope changes must use saveBatchScrapeJob. */
export function saveBatchScrapeProgress(job: PersistedBatchScrapeJob): void {
  const current = loadBatchScrapeJob()
  if (!current || !manifest || current.jobId !== job.jobId || current.kind !== job.kind) {
    saveBatchScrapeJob(job)
    return
  }
  persistProgress({ ...job, request: current.request, targets: current.targets, updatedAt: new Date().toISOString() }, manifest)
}

export function clearBatchScrapeJob(): void {
  const file = jobFilePath()
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
  } catch (error) {
    resetBatchScrapeJobCache()
    throw error
  }
  cache = null
  manifest = null
  pruneManifests()
}

export function hasPausedBatchScrapeJob(): boolean {
  const job = loadBatchScrapeJob()
  return job !== null
}

export function jobToBatchProgress(job: PersistedBatchScrapeJob): BatchProgress {
  const nextTarget = job.targets[job.nextIndex]
  return {
    total: job.total,
    current: job.nextIndex,
    success: job.success,
    pending: job.pending,
    failed: job.failed,
    currentCode: nextTarget?.label ?? null,
    status: 'paused',
    logs: [...job.logs]
  }
}

export function resetBatchScrapeJobCache(): void {
  cache = undefined
  manifest = null
}
