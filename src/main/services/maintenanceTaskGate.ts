export type MaintenanceTaskKind = 'scan' | 'resource-maintenance' | 'nfo-export'

export interface MaintenanceTaskLease {
  kind: MaintenanceTaskKind
  release(): void
}

export class MaintenanceTaskGate {
  private activeKind: MaintenanceTaskKind | null = null

  get active(): MaintenanceTaskKind | null {
    return this.activeKind
  }

  tryAcquire(kind: MaintenanceTaskKind): MaintenanceTaskLease | null {
    if (this.activeKind) return null
    this.activeKind = kind
    let released = false
    return {
      kind,
      release: () => {
        if (released) return
        released = true
        if (this.activeKind === kind) this.activeKind = null
      }
    }
  }

  runSync<T>(kind: MaintenanceTaskKind, work: () => T): T {
    const lease = this.tryAcquire(kind)
    if (!lease) throw new Error('已有扫描或资源维护任务正在运行')
    try {
      return work()
    } finally {
      lease.release()
    }
  }

  async run<T>(kind: MaintenanceTaskKind, work: () => Promise<T>): Promise<T> {
    const lease = this.tryAcquire(kind)
    if (!lease) throw new Error('已有扫描或资源维护任务正在运行')
    try {
      return await work()
    } finally {
      lease.release()
    }
  }
}

export const maintenanceTaskGate = new MaintenanceTaskGate()
