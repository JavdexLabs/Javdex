import type { createScanAuditReadIndex, ScanAuditIndexLimits, ScanAuditIndexPage, ScanAuditIndexQuery, ScanAuditSnapshotIdentity } from './scanAuditReadIndex'

import type { ScanAuditViewQuery, ScanAuditViewPage } from '@shared/scanAuditReadTypes'

type Index = Pick<ReturnType<typeof createScanAuditReadIndex>, 'readPage' | 'dispose'> & Partial<Pick<ReturnType<typeof createScanAuditReadIndex>, 'readViewPage'>>
/** One immutable index per worker, released before replacement and after inactivity. */
export class ScanAuditIndexSession {
  private current?: { key: string; index: Index; views: boolean }
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  constructor(private readonly options: {
    build: (snapshot: ScanAuditSnapshotIdentity, limits: ScanAuditIndexLimits, options: { views: boolean }) => Index
    revision: () => string
    idleMs?: number
  }) {
    if (!Number.isSafeInteger(options.idleMs ?? 30_000) || (options.idleMs ?? 30_000) <= 0) throw new Error('Invalid audit index idle timeout')
  }
  read(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditIndexQuery, limits: ScanAuditIndexLimits): ScanAuditIndexPage {
    return this.readUsing(snapshot, limits, false, index => index.readPage(query))
  }
  readView(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditViewQuery, limits: ScanAuditIndexLimits): ScanAuditViewPage {
    return this.readUsing(snapshot, limits, true, index => {
      if (!index.readViewPage) throw new Error('Audit view reader unavailable')
      return index.readViewPage(query)
    })
  }
  private readUsing<T>(snapshot: ScanAuditSnapshotIdentity, limits: ScanAuditIndexLimits, views: boolean, read: (index: Index) => T): T {
    if (this.disposed) throw new Error('Audit index session disposed')
    clearTimeout(this.timer)
    try {
      const key = JSON.stringify([this.options.revision(), snapshot.libraryId, snapshot.runId, snapshot.finishedAt,
        limits.sourceBytes, limits.indexBytes, limits.pageBytes])
      if (this.current?.key !== key || (views && !this.current.views)) {
        this.drop()
        this.current = { key, views, index: this.options.build(snapshot, limits, { views }) }
      }
      const result = read(this.current.index)
      this.timer = setTimeout(() => this.drop(), this.options.idleMs ?? 30_000)
      this.timer.unref?.()
      return result
    } catch (error) { this.drop(); throw error }
  }
  private drop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const current = this.current
    this.current = undefined
    current?.index.dispose()
  }
  dispose(): void { this.disposed = true; this.drop() }
}
