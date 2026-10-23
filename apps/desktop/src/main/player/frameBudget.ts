/** Processing budget, not a display delay. Ignore immediate redraws and
 * outliers; update at most once per 2s/30 samples, with asymmetric slew limits. */
export class FrameBudget {
  value = 20
  private samples: number[] = []
  private updated = 0
  reset(): void { this.value = 20; this.samples = []; this.updated = 0 }
  observe(cost: number, now: number): number | undefined {
    if (!Number.isFinite(cost) || cost < 0 || cost > 100) return
    this.samples.push(cost)
    if (this.samples.length > 120) this.samples.shift()
    if (this.samples.length < 30 || now - this.updated < 2000) return
    this.updated = now
    const sorted = [...this.samples].sort((a, b) => a - b)
    const desired = Math.max(8, Math.min(40, Math.ceil(sorted[Math.floor(sorted.length * .95)] + 4)))
    if (Math.abs(desired - this.value) < 2) return
    this.value = Math.max(this.value - 1, Math.min(this.value + 2, desired))
    return this.value
  }
}
