const failure = (message: string, code: string): Error => Object.assign(new Error(message), { playbackFailureCode: code })
/** A known synthetic frame through the real texture/Canvas route. Arbitrary
 * movie pixels, draw submissions and black scenes are never health signals. */
export class FrameHealthProbe {
  state: 'pending' | 'passed' = 'pending'
  private sequence?: number
  private binding?: string
  private since?: number
  reset(): void { this.state = 'pending'; this.sequence = undefined; this.binding = undefined; this.since = undefined }
  exported(sequence: number, binding: string, width: number, height: number): boolean {
    if (width !== 640 || height !== 360) throw failure('共享视频合成色块自检失败', 'DISPLAY_SELF_TEST_FAILED')
    if (this.sequence !== undefined || this.state === 'passed') return false
    this.sequence = sequence; this.binding = binding; return true
  }
  receive(value: { sequence?: unknown; bindingToken: string; samples?: unknown }): boolean {
    if (this.state !== 'pending' || this.sequence === undefined || value.sequence !== this.sequence || value.bindingToken !== this.binding) return false
    const samples = value.samples
    if (!Array.isArray(samples) || samples.length !== 20 || !samples.every((v, i) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255 && Math.abs(v - [64, 191, 128, 255][i % 4]) <= 8))
      throw failure('共享视频合成色块自检失败', 'DISPLAY_SELF_TEST_FAILED')
    this.state = 'passed'; this.since = undefined; return true
  }
  tick(visible: boolean, now: number): void {
    if (!visible || this.state === 'passed') { this.since = undefined; return }
    this.since ??= now
    if (now - this.since > 8000) throw failure('共享视频合成色块自检超时', 'DISPLAY_SELF_TEST_TIMEOUT')
  }
}
