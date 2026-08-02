import type { ScraperPluginKind } from '@shared/types'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_PLUGIN_BYTES = 64 * 1024 * 1024

export interface ScraperResourceRequest {
  kind: ScraperPluginKind
  pluginName: string
  url: string
  maxAgeMs: number
  staleIfError: boolean
}

export interface ScraperResourceResponse {
  statusCode: number
  body: Buffer
  etag?: string
}

export type ScraperResourceFetcher = (
  url: string,
  headers: Readonly<Record<string, string>>
) => Promise<ScraperResourceResponse>

interface CachedResource {
  body: Buffer
  etag?: string
  fetchedAt: number
}

interface PersistedResourceMetadata {
  schemaVersion: 2
  url: string
  fetchedAt: number
  bodyFile: string
  etag?: string
}

export class ScraperResourceCache {
  private readonly memory = new Map<string, CachedResource>()
  private readonly pluginCommits = new Map<string, Promise<void>>()

  constructor(
    private readonly options: {
      rootDir: string
      now?: () => number
      maxEntryBytes?: number
      maxPluginBytes?: number
    }
  ) {}

  async fetch(
    request: ScraperResourceRequest,
    fetcher: ScraperResourceFetcher
  ): Promise<Buffer> {
    const key = `${request.kind}\0${request.pluginName}\0${request.url}`
    const now = (this.options.now ?? Date.now)()
    const cached = this.memory.get(key) ?? this.readPersisted(request)
    if (cached) this.memory.set(key, cached)
    if (cached && now - cached.fetchedAt <= request.maxAgeMs) {
      return cached.body
    }

    try {
      const response = await fetcher(
        request.url,
        cached?.etag ? { 'If-None-Match': cached.etag } : {}
      )
      if (response.statusCode === 304) {
        if (!cached) throw new Error('HTTP 304 without a cached resource')
        const revalidated = { ...cached, fetchedAt: now }
        await this.commitPersisted(request, revalidated)
        this.memory.set(key, revalidated)
        return revalidated.body
      }
      if (response.statusCode !== 200) {
        throw new Error(`HTTP ${response.statusCode}`)
      }
      const maxEntryBytes = this.options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
      if (response.body.byteLength > maxEntryBytes) {
        throw new Error(
          `Resource exceeds the persistent cache entry limit (${maxEntryBytes} bytes)`
        )
      }
      const next = {
        body: response.body,
        etag: response.etag,
        fetchedAt: now
      }
      await this.commitPersisted(request, next)
      this.memory.set(key, next)
      return response.body
    } catch (error) {
      if (cached && request.staleIfError) return cached.body
      throw error
    }
  }

  private readPersisted(request: ScraperResourceRequest): CachedResource | undefined {
    const { pluginDir } = this.entryPaths(request)
    try {
      const parsed = this.readPersistedManifest(request)
      if (!parsed) return undefined
      return {
        body: fs.readFileSync(path.join(pluginDir, parsed.bodyFile)),
        fetchedAt: parsed.fetchedAt,
        etag: typeof parsed.etag === 'string' ? parsed.etag : undefined
      }
    } catch {
      return undefined
    }
  }

  private async commitPersisted(
    request: ScraperResourceRequest,
    resource: CachedResource
  ): Promise<void> {
    const pluginKey = `${request.kind}\0${request.pluginName}`
    const previous = this.pluginCommits.get(pluginKey)
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.pluginCommits.set(pluginKey, current)

    try {
      if (previous) await previous
      this.assertPluginQuota(request, resource.body.byteLength)
      this.writePersisted(request, resource)
    } finally {
      release()
      if (this.pluginCommits.get(pluginKey) === current) {
        this.pluginCommits.delete(pluginKey)
      }
    }
  }

  private writePersisted(request: ScraperResourceRequest, resource: CachedResource): void {
    const { bodyPrefix, metadataPath, pluginDir } = this.entryPaths(request)
    fs.mkdirSync(pluginDir, { recursive: true })
    const suffix = `${process.pid}-${crypto.randomUUID()}`
    const bodyFile = `${bodyPrefix}.${suffix}.bin`
    const bodyPath = path.join(pluginDir, bodyFile)
    const bodyTemp = `${bodyPath}.tmp`
    const metadataTemp = `${metadataPath}.${suffix}.tmp`
    const previousBodyPath = this.readPersistedBodyPath(request)
    const metadata: PersistedResourceMetadata = {
      schemaVersion: 2,
      url: request.url,
      fetchedAt: resource.fetchedAt,
      bodyFile,
      ...(resource.etag ? { etag: resource.etag } : {})
    }
    let committed = false

    try {
      fs.writeFileSync(bodyTemp, resource.body)
      fs.renameSync(bodyTemp, bodyPath)
      fs.writeFileSync(metadataTemp, JSON.stringify(metadata), 'utf-8')
      fs.renameSync(metadataTemp, metadataPath)
      committed = true
      if (previousBodyPath && previousBodyPath !== bodyPath) {
        fs.rmSync(previousBodyPath, { force: true })
      }
    } finally {
      fs.rmSync(bodyTemp, { force: true })
      fs.rmSync(metadataTemp, { force: true })
      if (!committed) fs.rmSync(bodyPath, { force: true })
    }
  }

  private assertPluginQuota(request: ScraperResourceRequest, nextBytes: number): void {
    const { pluginDir } = this.entryPaths(request)
    const existingBodyPath = this.readPersistedBodyPath(request)
    const existingBytes =
      existingBodyPath && fs.existsSync(existingBodyPath)
        ? fs.statSync(existingBodyPath).size
        : 0
    const currentBytes = fs.existsSync(pluginDir)
      ? fs
          .readdirSync(pluginDir)
          .filter((name) => name.endsWith('.bin'))
          .reduce((total, name) => total + fs.statSync(path.join(pluginDir, name)).size, 0)
      : 0
    const maxPluginBytes = this.options.maxPluginBytes ?? DEFAULT_MAX_PLUGIN_BYTES
    if (currentBytes - existingBytes + nextBytes > maxPluginBytes) {
      throw new Error(
        `Resource exceeds the persistent cache plugin limit (${maxPluginBytes} bytes)`
      )
    }
  }

  private entryPaths(request: ScraperResourceRequest): {
    bodyPrefix: string
    metadataPath: string
    pluginDir: string
  } {
    const pluginDigest = crypto
      .createHash('sha256')
      .update(`${request.kind}\0${request.pluginName}`)
      .digest('hex')
    const pluginDir = path.join(this.options.rootDir, pluginDigest)
    const digest = crypto.createHash('sha256').update(request.url).digest('hex')
    return {
      bodyPrefix: digest,
      metadataPath: path.join(pluginDir, `${digest}.json`),
      pluginDir
    }
  }

  private readPersistedBodyPath(request: ScraperResourceRequest): string | undefined {
    const { pluginDir } = this.entryPaths(request)
    const parsed = this.readPersistedManifest(request)
    return parsed ? path.join(pluginDir, parsed.bodyFile) : undefined
  }

  private readPersistedManifest(
    request: ScraperResourceRequest
  ): PersistedResourceMetadata | undefined {
    const { bodyPrefix, metadataPath } = this.entryPaths(request)
    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Partial<
        PersistedResourceMetadata
      >
      if (
        parsed.schemaVersion !== 2 ||
        parsed.url !== request.url ||
        typeof parsed.bodyFile !== 'string' ||
        !parsed.bodyFile.startsWith(`${bodyPrefix}.`) ||
        !parsed.bodyFile.endsWith('.bin') ||
        path.basename(parsed.bodyFile) !== parsed.bodyFile
      ) {
        return undefined
      }
      if (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt)) {
        return undefined
      }
      return parsed as PersistedResourceMetadata
    } catch {
      return undefined
    }
  }
}
