/** Processing budget, not a display delay. Ignore immediate redraws and
 * outliers; update at most once per 2s/30 samples, with asymmetric slew limits. */
export class FrameBudget {
  value = 20
  private samples: number[] = []
  private updated = 0
  private dropFloor = 8
  private drops: { count: number; time: number } | undefined
  reset(preserveDropFloor = false): void {
    if (!preserveDropFloor) this.dropFloor = 8
    this.value = Math.max(20, this.dropFloor); this.samples = []; this.updated = 0; this.drops = undefined
  }
  /** Decoder/download work can precede the render callback and its cost sample.
   * Learn a session floor from sustained upstream drops, never from one redraw.
   * The caller can retain that floor across seeks within the same host. */
  observeDrops(count: number | undefined, active: boolean, now: number): number | undefined {
    if (!active || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) { this.drops = undefined; return }
    const previous = this.drops
    if (!previous || count < previous.count || now < previous.time) { this.drops = { count, time: now }; return }
    if (now - previous.time < 2000) return
    // Do not erase one drop every two seconds: sparse but recurring misses
    // still indicate insufficient headroom. Expire isolated pressure at 10s.
    if (count - previous.count < 2) {
      if (now - previous.time >= 10000) this.drops = { count, time: now }
      return
    }
    this.drops = { count, time: now }
    const next = Math.min(40, this.value + 4)
    this.dropFloor = next
    if (next === this.value) return
    this.value = next; this.updated = now
    return this.value
  }
  observe(cost: number, now: number): number | undefined {
    if (!Number.isFinite(cost) || cost < 0 || cost > 100) return
    this.samples.push(cost)
    if (this.samples.length > 120) this.samples.shift()
    if (this.samples.length < 30 || now - this.updated < 2000) return
    this.updated = now
    const sorted = [...this.samples].sort((a, b) => a - b)
    const desired = Math.max(this.dropFloor, Math.min(40, Math.ceil(sorted[Math.floor(sorted.length * .95)] + 4)))
    if (Math.abs(desired - this.value) < 2) return
    this.value = Math.max(this.value - 1, Math.min(this.value + 2, desired))
    return this.value
  }
}
