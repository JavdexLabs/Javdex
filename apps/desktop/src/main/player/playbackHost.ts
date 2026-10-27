// Private utility-process entry. libmpv and graphics drivers are loaded here,
// never in the application's main process. No renderer API is exposed.
import type { MessagePortMain } from 'electron'
import { createRequire } from 'node:module'
import type { CpuFramePortMessage, HostFrame, HostRequest, HostResponse } from './playbackHostProtocol'
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
const directCpuFrames = !gpu && ['darwin', 'win32'].includes(process.platform)
let cpuFramePort: { port: MessagePortMain; id: string } | undefined
const detachCpuPort = (): void => { const previous = cpuFramePort; cpuFramePort = undefined; previous?.port.close() }
const announced = new Map<number, number>()
const send = (message: HostResponse): void => port.postMessage(message)
const postCpuMessage = (message: CpuFramePortMessage): void => {
  const owner = cpuFramePort
  if (!owner) return
  try { owner.port.postMessage(message) }
  catch { detachCpuPort(); send({ type: 'cpu-frame-port-closed', cpuChannelId: owner.id }) }
}
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
    const frame = (gpu ? native.nextFrame() : native.nextFrame(cpuCredits.size < 2 && (!directCpuFrames || !!cpuFramePort))) as HostFrame | undefined
    if (frame) {
      if (interop) {
        if (announced.get(frame.slot!) !== frame.resourceId) {
          interop.publishSurface(channel, frame.sequence, frame.ioSurface as Buffer)
          announced.set(frame.slot!, frame.resourceId!)
        }
        delete frame.ioSurface
      }
      if (!gpu) cpuCredits.add(frame.sequence)
      if (directCpuFrames) {
        const owner = cpuFramePort!
        const pixels = frame.pixels; delete frame.pixels; frame.cpuChannelId = owner.id
        if (process.env.JAVDEX_PLAYBACK_DIAGNOSTICS === '1') frame.cpuPostStartUs = Number(process.hrtime.bigint()) / 1000
        postCpuMessage({ cpuChannelId: owner.id, sequence: frame.sequence, timeline: frame.timeline!, pixels: pixels! })
        if (frame.cpuPostStartUs !== undefined) frame.cpuPostDoneUs = Number(process.hrtime.bigint()) / 1000
      }
      send({ type: 'frame', frame })
    }
  } catch (error) { fail(error) }
  finally { polling = false }
}
port.on('message', ({ data, ports = [] }: { data: HostRequest; ports?: MessagePortMain[] }) => {
  if (stopped) return
  try {
    if (data.type === 'cpu-frame-port') {
      if (!directCpuFrames || ports.length !== 1 || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(data.cpuChannelId)) throw new Error('Invalid CPU pixel port')
      detachCpuPort()
      const owner = cpuFramePort = { port: ports[0], id: data.cpuChannelId }
      owner.port.on('close', () => {
        if (cpuFramePort !== owner || stopped) return
        cpuFramePort = undefined; send({ type: 'cpu-frame-port-closed', cpuChannelId: owner.id })
      })
      owner.port.start(); return
    }
    if (data.type === 'cpu-frame-detached') { if (cpuFramePort?.id === data.cpuChannelId) detachCpuPort(); return }
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
      detachCpuPort(); native.destroy(); process.exit(0)
    } else if (!created) throw new Error('Playback host not initialized')
    else if (data.type === 'bounds') native.setBounds(data.bounds)
    else if (data.type === 'visible') native.setVisible(data.value)
    else if (data.type === 'command') native.command(data.args, data.generated)
    else if (data.type === 'subtitles') native.generatedSubtitles(data.operation, data.document, data.visible, data.revision)
    else if (data.type === 'release') {
      if (gpu) native.releaseFrame(data.sequence)
      else {
        // Order retirement before replacement pixels on the same private port.
        // A main-process IPC notification could lag behind recycled credit.
        if (directCpuFrames && cpuFramePort && cpuCredits.has(data.sequence))
          postCpuMessage({ type: 'retired', cpuChannelId: cpuFramePort.id, sequence: data.sequence })
        cpuCredits.delete(data.sequence)
      }
    }
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
