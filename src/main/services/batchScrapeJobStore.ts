import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type {
  ActressBatchScrapeRequest,
  BatchLogEntry,
  BatchProgress,
  VideoBatchScrapeRequest
} from '@shared/types'
import { readTestUserDataPath } from '@shared/appIdentity'

export type BatchScrapeJobKind = 'video' | 'actress'

export interface BatchScrapeJobTarget {
  id: number
  label: string
}

export interface PersistedBatchScrapeJob {
  kind: BatchScrapeJobKind
  request: VideoBatchScrapeRequest | ActressBatchScrapeRequest
  targets: BatchScrapeJobTarget[]
  nextIndex: number
  success: number
  failed: number
  logs: BatchLogEntry[]
  total: number
  status: 'running' | 'paused'
  updatedAt: string
}

let cache: PersistedBatchScrapeJob | null | undefined

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
    const parsed = JSON.parse(raw) as Partial<PersistedBatchScrapeJob>
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
      return null
    }
    return {
      kind: parsed.kind,
      request: parsed.request as VideoBatchScrapeRequest | ActressBatchScrapeRequest,
      targets: parsed.targets as BatchScrapeJobTarget[],
      nextIndex: Math.max(0, Math.floor(parsed.nextIndex)),
      success: Math.max(0, Math.floor(parsed.success)),
      failed: Math.max(0, Math.floor(parsed.failed)),
      logs: parsed.logs as BatchLogEntry[],
      total: Math.max(0, Math.floor(parsed.total)),
      status: parsed.status === 'running' ? 'running' : 'paused',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
    }
  } catch {
    return null
  }
}

function writeJobFile(job: PersistedBatchScrapeJob | null): void {
  const file = jobFilePath()
  if (!job) {
    cache = null
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (err) {
      console.error('Failed to clear batch scrape job:', err)
    }
    return
  }
  cache = job
  try {
    fs.writeFileSync(jobFilePath(), JSON.stringify(job, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to persist batch scrape job:', err)
  }
}

export function loadBatchScrapeJob(): PersistedBatchScrapeJob | null {
  if (cache !== undefined) return cache
  cache = readJobFile()
  return cache
}

export function saveBatchScrapeJob(job: PersistedBatchScrapeJob): void {
  writeJobFile({ ...job, updatedAt: new Date().toISOString() })
}

export function clearBatchScrapeJob(): void {
  writeJobFile(null)
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
    failed: job.failed,
    currentCode: nextTarget?.label ?? null,
    status: 'paused',
    logs: [...job.logs]
  }
}

export function resetBatchScrapeJobCache(): void {
  cache = undefined
}
