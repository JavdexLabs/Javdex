import type { CpuFrameBinding, CpuFramePortBinding, CpuFramePixels, CpuFrameEnvelope, CpuFramePortMessage } from '../main/player/playbackHostProtocol'

export interface CpuPixelsPort {
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror: (() => void) | null
  start(): void
  close(): void
}
interface Display extends CpuFrameBinding { timeline: number }
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const timeline = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const same = (a: CpuFrameBinding, b: CpuFrameBinding): boolean => a.surfaceToken === b.surfaceToken && a.bindingToken === b.bindingToken

/** Joins separately delivered pixels and main-validated envelopes. Both queues
 * share the producer's two-copy credit bound. Future timeline pixels must survive
 * a flush that arrives later over the control channel. */
export function createCpuFramePortReceiver(options: {
  current(): Display | null
  consume(frame: CpuFrameEnvelope & { pixels: Uint8Array }): Promise<void>
  release(binding: CpuFrameBinding, sequence: number): void
  fail(binding: CpuFrameBinding): void
}) {
  const pixels = new Map<number, CpuFramePixels>(), envelopes = new Map<number, CpuFrameEnvelope>()
  let channel: { binding: CpuFramePortBinding; port: CpuPixelsPort; floor: number; lastPixels: number; lastEnvelope: number } | undefined
  const stop = (): void => {
    const previous = channel; channel = undefined
    const pending = [...envelopes.values()]; pixels.clear(); envelopes.clear()
    try { if (previous) { previous.port.onmessage = previous.port.onmessageerror = null; previous.port.close() } } catch { /* Already gone. */ }
    for (const envelope of pending) { try { options.release(envelope, envelope.sequence) } catch { /* Endpoint already gone. */ } }
  }
  const fail = (): void => {
    const previous = channel
    stop()
    if (previous) { try { options.fail(previous.binding) } catch { /* Endpoint already gone. */ } }
  }
  const release = (envelope: CpuFrameEnvelope): void => {
    try { options.release(envelope, envelope.sequence) } catch { fail() }
  }
  const retire = (value: unknown): void => {
    const v = value as CpuFramePortBinding & { sequence: number } | null, owner = channel
    if (!owner || !v || !same(owner.binding, v) || v.cpuChannelId !== owner.binding.cpuChannelId || !sequence(v.sequence)) return
    owner.floor = Math.max(owner.floor, v.sequence)
    for (const id of pixels.keys()) if (id <= owner.floor) pixels.delete(id)
    for (const [id, envelope] of envelopes) if (id <= owner.floor) {
      envelopes.delete(id)
      // Only the notified sequence is already retired by main. Earlier unmatched
      // envelopes also lose their pixels at this watermark and need credit back.
      if (id !== v.sequence) release(envelope)
    }
  }
  const join = (id: number): void => {
    const owner = channel, display = options.current(), envelope = envelopes.get(id), data = pixels.get(id)
    if (!owner || !display || !same(owner.binding, display) || !envelope || !data) return
    if (envelope.timeline !== data.timeline || data.pixels.byteLength !== envelope.size) { fail(); return }
    if (envelope.timeline !== display.timeline) return
    envelopes.delete(id); pixels.delete(id)
    void options.consume({ ...envelope, pixels: data.pixels }).catch(() => { if (channel === owner) fail() })
  }
  return {
    attach(value: unknown, port: CpuPixelsPort | undefined): void {
      const binding = value as CpuFramePortBinding | null, display = options.current()
      if (!port || !binding || !display || !same(binding, display) || typeof binding.cpuChannelId !== 'string'
        || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(binding.cpuChannelId)) { port?.close(); return }
      stop()
      const owner = channel = { binding, port, floor: 0, lastPixels: 0, lastEnvelope: 0 }
      port.onmessage = ({ data: value }) => {
        if (channel !== owner) return
        const data = value as CpuFramePortMessage | null, current = options.current()
        if (!current || !same(current, owner.binding)) { stop(); return }
        if (!data || data.cpuChannelId !== owner.binding.cpuChannelId || !sequence(data.sequence)) { fail(); return }
        if ('type' in data) {
          if (data.type !== 'retired') { fail(); return }
          retire({ ...owner.binding, sequence: data.sequence }); return
        }
        if (!timeline(data.timeline) || !(data.pixels instanceof Uint8Array) || !data.pixels.byteLength || data.pixels.byteLength > 256 * 1024 * 1024
          || data.sequence <= owner.lastPixels) { fail(); return }
        owner.lastPixels = data.sequence
        if (data.sequence <= owner.floor || data.timeline < current.timeline) return
        if (pixels.size >= 2) { fail(); return }
        pixels.set(data.sequence, data); join(data.sequence)
      }
      port.onmessageerror = () => { if (channel === owner) fail() }
      try { port.start() } catch { fail() }
    },
    frame(value: unknown): boolean {
      const envelope = value as CpuFrameEnvelope | null
      if (!envelope || typeof envelope.cpuChannelId !== 'string') return false
      const owner = channel, display = options.current()
      if (!owner || !display || !same(owner.binding, display) || !same(owner.binding, envelope) || envelope.cpuChannelId !== owner.binding.cpuChannelId) {
        if (sequence(envelope.sequence)) release(envelope)
        return true
      }
      if (!sequence(envelope.sequence) || !timeline(envelope.timeline) || !sequence(envelope.size)
        || envelope.size > 256 * 1024 * 1024 || envelope.sequence <= owner.lastEnvelope) { fail(); return true }
      owner.lastEnvelope = envelope.sequence
      if (envelope.sequence <= owner.floor) { release(envelope); return true }
      if (envelope.timeline < display.timeline) { release(envelope); pixels.delete(envelope.sequence); return true }
      if (envelopes.size >= 2) { fail(); return true }
      envelopes.set(envelope.sequence, envelope); join(envelope.sequence)
      return true
    },
    retire,
    flush(): void {
      const display = options.current()
      if (!channel || !display || !same(channel.binding, display)) return
      for (const [id, envelope] of envelopes) if (envelope.timeline < display.timeline) {
        release(envelope); envelopes.delete(id); pixels.delete(id)
      }
      for (const [id, data] of pixels) if (data.timeline < display.timeline) pixels.delete(id)
      for (const id of envelopes.keys()) join(id)
    },
    dispose(binding: CpuFrameBinding): void { if (channel && same(channel.binding, binding)) stop() }
  }
}
