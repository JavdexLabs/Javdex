// Private utility-process entry. libmpv and graphics drivers are loaded here,
// never in the application's main process. No renderer API is exposed.
import { createRequire } from 'node:module'
import type { HostFrame, HostRequest, HostResponse } from './playbackHostProtocol'
import type { SharedTextureProducer } from './nativeSharedTexture'
import type { SoftwareProducer } from './softwarePlayback'

const [runtime, mode, channel, interopFile] = process.argv.slice(2)
const port = process.parentPort
if (!port || !runtime || !['gpu', 'cpu'].includes(mode)) throw new Error('Invalid playback host invocation')
const require = createRequire(import.meta.url)
const module = require(runtime)
const gpu = mode === 'gpu'
const native = (gpu ? process.platform === 'win32' ? module.sharedTexture : module : module.software) as SoftwareProducer & SharedTextureProducer
const interop = gpu && process.platform === 'darwin' ? require(interopFile) as { publishSurface(channel: string, sequence: number, pointer: Buffer): void } : null
let created = false, stopped = false, polling = false
const cpuCredits = new Set<number>()
const announced = new Map<number, number>()
const send = (message: HostResponse): void => port.postMessage(message)
const fail = (error: unknown): void => {
  if (stopped) return
  console.error('[playback-host]', error)
  stopped = true; send({ type: 'failed' })
  // A fatal native call can leave driver state uncertain. The parent bounds
  // shutdown and retains any imported resources until their consumers release.
  process.exitCode = 1
}
const poll = (): void => {
  if (!created || stopped || polling) return
  polling = true
  try {
    const frame = (gpu ? native.nextFrame() : native.nextFrame(cpuCredits.size < 2)) as HostFrame | undefined
    if (frame) {
      if (interop) {
        if (announced.get(frame.slot!) !== frame.resourceId) {
          interop.publishSurface(channel, frame.sequence, frame.ioSurface as Buffer)
          announced.set(frame.slot!, frame.resourceId!)
        }
        delete frame.ioSurface
      }
      if (!gpu) cpuCredits.add(frame.sequence)
      send({ type: 'frame', frame })
    }
  } catch (error) { fail(error) }
  finally { polling = false }
}
port.on('message', ({ data }: { data: HostRequest }) => {
  if (stopped) return
  try {
    if (data.type === 'create') {
      if (created) throw new Error('Playback host already initialized')
      if (gpu && process.platform === 'win32') native.create(data.bounds, data.windowsAdapter)
      else native.create(data.bounds)
      created = true
      if (gpu) native.setWakeup(poll)
    } else if (data.type === 'stall' && process.env.JAVDEX_PLAYBACK_DIAGNOSTICS === '1') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    } else if (data.type === 'destroy') {
      stopped = true
      if (gpu && created) native.setWakeup(null)
      native.destroy(); process.exit(0)
    } else if (!created) throw new Error('Playback host not initialized')
    else if (data.type === 'bounds') native.setBounds(data.bounds)
    else if (data.type === 'visible') native.setVisible(data.value)
    else if (data.type === 'command') native.command(data.args, data.generated)
    else if (data.type === 'subtitles') native.generatedSubtitles(data.operation, data.document, data.visible, data.revision)
    else if (data.type === 'release') { if (gpu) native.releaseFrame(data.sequence); else cpuCredits.delete(data.sequence) }
    else if (data.type === 'timing') native.resetTiming(data.timeline)
    else if (data.type === 'budget') native.setRenderBudget(data.milliseconds)
    else if (data.type === 'probe' && gpu) native.requestSelfTest()
    send({ type: 'ack' })
    poll()
  } catch (error) { fail(error) }
})
setInterval(poll, gpu ? 250 : 8).unref()
setInterval(() => {
  if (created && !stopped) {
    try { send({ type: 'state', state: native.state() }) } catch (error) { fail(error) }
  }
}, 100).unref()
send({ type: 'ready' })
