import path from 'node:path'
import { normalizeExternalVideoResource } from '@shared/videoResourceLinks'
import type { StrmVideoResourceRef } from '../db/videoRepo'
import type { getDatabaseReadRevision } from '../db/database'

type Revision = ReturnType<typeof getDatabaseReadRevision>
type Resource = StrmVideoResourceRef & { root_id: number | null }

interface Ports {
  revision(): Revision
  list(): StrmVideoResourceRef[]
  get(id: number): Resource | null
  getByPath(sourcePath: string): Resource | null
  inspect(sourcePath: string): 'present' | 'missing' | 'unknown'
  unavailableRootIds: ReadonlySet<number>
}

function sameRevision(a: Revision | null, b: Revision): boolean {
  return a?.connection === b.connection && a.changes === b.changes && a.dataVersion === b.dataVersion
}

function key(resource: StrmVideoResourceRef): string | null {
  try {
    return JSON.stringify([
      path.basename(resource.source_path),
      normalizeExternalVideoResource(resource.locator, resource.kind).resourceKey
    ])
  } catch {
    return null
  }
}

/** Scan-local candidate index. Never caches filesystem presence or uniqueness decisions. */
export class StrmRelocationIndex {
  private revision: Revision | null = null
  private readonly buckets = new Map<string, Map<number, StrmVideoResourceRef>>()
  private readonly keys = new Map<number, string>()
  private writeDepth = 0

  constructor(private readonly ports: Ports) {}

  find(sourcePath: string, targetKey: string): StrmVideoResourceRef | null {
    const revision = this.ports.revision()
    if (!sameRevision(this.revision, revision)) {
      this.buckets.clear()
      this.keys.clear()
      for (const resource of this.ports.list()) this.upsert(resource)
      this.revision = revision
    }
    const bucket = this.buckets.get(JSON.stringify([path.basename(sourcePath), targetKey]))
    let candidate: StrmVideoResourceRef | null = null
    for (const ref of bucket?.values() ?? []) {
      const current = this.ports.get(ref.resource_id)
      if (!current?.root_id || this.ports.unavailableRootIds.has(current.root_id)) continue
      if (key(current) !== key(ref) || this.ports.inspect(current.source_path) !== 'missing') continue
      if (candidate) return null
      candidate = current
    }
    return candidate
  }

  /** Wrap only a synchronous mutation of this source; unrelated writes force a rebuild. */
  mutate<T>(sourcePath: string, write: () => T): T {
    return this.trackWrite(write, () => {
      const current = this.ports.getByPath(sourcePath)
      if (!current) return false
      this.upsert(current)
      return true
    })
  }

  /** Only for known synchronous writes that cannot change video_resources. */
  mutateWithoutResourceChanges<T>(write: () => T): T {
    // An enclosing tracked resource mutation owns both the revision and bucket
    // update. Only this explicitly resource-free wrapper may skip nested tracking.
    if (this.writeDepth > 0) return write()
    return this.trackWrite(write, () => true)
  }

  private trackWrite<T>(write: () => T, update: () => boolean): T {
    if (!this.revision) return write()
    const before = this.ports.revision()
    this.writeDepth++
    try {
      const result = write()
      const after = this.ports.revision()
      if (sameRevision(this.revision, before) && before.dataVersion === after.dataVersion &&
          before.connection === after.connection && update()) {
        this.revision = after
      } else {
        this.revision = null
      }
      return result
    } catch (error) {
      this.revision = null
      throw error
    } finally {
      this.writeDepth--
    }
  }

  private upsert(resource: StrmVideoResourceRef): void {
    const oldKey = this.keys.get(resource.resource_id)
    if (oldKey !== undefined) {
      const old = this.buckets.get(oldKey)
      old?.delete(resource.resource_id)
      if (!old?.size) this.buckets.delete(oldKey)
      this.keys.delete(resource.resource_id)
    }
    const nextKey = key(resource)
    if (nextKey === null) return
    let bucket = this.buckets.get(nextKey)
    if (!bucket) {
      bucket = new Map()
      this.buckets.set(nextKey, bucket)
    }
    bucket.set(resource.resource_id, resource)
    this.keys.set(resource.resource_id, nextKey)
  }
}
