// Stub the external Worker Interface, never transform production source strings.
const NativeWorker = window.Worker
window.Worker = class {
  constructor(url, options) {
    if (options?.name !== 'avatar-auto-crop') return new NativeWorker(url, options)
    this.stopped = false
  }
  postMessage(message) {
    if (this.stopped || message.type !== 'analyze') return
    message.bitmap?.close()
    if (window.fixtureAvatarAnalysisMode === 'pending') return
    queueMicrotask(() => {
      if (!this.stopped) this.onmessage?.({ data: { type: 'error', requestId: message.requestId, error: 'Synthetic analysis unavailable' } })
    })
  }
  terminate() { this.stopped = true }
}
