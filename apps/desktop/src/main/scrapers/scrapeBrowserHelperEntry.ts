import { app } from 'electron'
import net from 'node:net'
import {
  SCRAPE_BROWSER_HELPER_FLAG,
  SCRAPE_BROWSER_PROTOCOL_VERSION,
  ScrapeBrowserFramedSocket,
  type ScrapeBrowserProtocolFrame,
  type ScrapeBrowserRequestFrame
} from './scrapeBrowserProtocol'
import { ScrapeBrowserHelperRuntime } from './scrapeBrowserHelperRuntime'

const ENV_PIPE = 'JAVDEX_SCRAPER_HELPER_PIPE'
const ENV_TOKEN = 'JAVDEX_SCRAPER_HELPER_TOKEN'
const ENV_PROFILE = 'JAVDEX_SCRAPER_HELPER_PROFILE'
const ENV_CDP_PORT = 'JAVDEX_SCRAPER_HELPER_CDP_PORT'
const ENV_PARENT_PID = 'JAVDEX_SCRAPER_HELPER_PARENT_PID'

interface HelperEnvironment {
  pipe: string
  token: string
  profile: string
  cdpPort: number
  parentPid: number
}

export function isScrapeBrowserHelperMode(): boolean {
  return process.argv.includes(SCRAPE_BROWSER_HELPER_FLAG)
}

function readEnvironment(): HelperEnvironment {
  const pipe = process.env[ENV_PIPE]?.trim() ?? ''
  const token = process.env[ENV_TOKEN]?.trim() ?? ''
  const profile = process.env[ENV_PROFILE]?.trim() ?? ''
  const cdpPort = Number(process.env[ENV_CDP_PORT])
  const parentPid = Number(process.env[ENV_PARENT_PID])
  if (!pipe || !profile || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('Scraper helper environment is incomplete')
  }
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
    throw new Error('Scraper helper CDP port is invalid')
  }
  if (!Number.isInteger(parentPid) || parentPid <= 1) {
    throw new Error('Scraper helper parent PID is invalid')
  }
  return { pipe, token, profile, cdpPort, parentPid }
}

function errorShape(error: unknown): {
  name: string
  code?: string
  message: string
  url?: string
  title?: string
} {
  const candidate = error as {
    name?: unknown
    code?: unknown
    message?: unknown
    url?: unknown
    title?: unknown
  }
  return {
    name: typeof candidate?.name === 'string' ? candidate.name : 'Error',
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
    ...(typeof candidate?.url === 'string' ? { url: candidate.url } : {}),
    ...(typeof candidate?.title === 'string' ? { title: candidate.title } : {})
  }
}

function assertParentAlive(parentPid: number): boolean {
  try {
    process.kill(parentPid, 0)
    return true
  } catch {
    return false
  }
}

export async function startScrapeBrowserHelper(): Promise<void> {
  const env = readEnvironment()

  // These paths and switches must be fixed before Electron becomes ready.
  app.setPath('userData', env.profile)
  app.setPath('sessionData', env.profile)
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', String(env.cdpPort))
  app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests')

  await app.whenReady()
  app.dock?.hide()

  let shuttingDown = false
  const socket = net.createConnection(env.pipe)
  const requests = new Map<string, AbortController>()
  // Assigned after callbacks are declared; callbacks cannot run before the socket connects.
  // eslint-disable-next-line prefer-const
  let framed: ScrapeBrowserFramedSocket
  const runtime = new ScrapeBrowserHelperRuntime(() => {
    if (shuttingDown) return
    try {
      framed.send({ type: 'event', event: 'window-closed', message: 'Scraper window closed' })
    } catch {
      // Parent disconnection below is authoritative.
    }
    app.quit()
  })

  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    for (const controller of requests.values()) controller.abort(new Error('Helper is shutting down'))
    requests.clear()
    runtime.close()
    framed?.close()
    app.quit()
  }

  const respond = async (frame: ScrapeBrowserRequestFrame): Promise<void> => {
    if (requests.has(frame.id)) {
      framed.send({
        type: 'response',
        id: frame.id,
        ok: false,
        error: { name: 'Error', code: 'DUPLICATE_REQUEST', message: 'Duplicate request id' }
      })
      return
    }
    const controller = new AbortController()
    requests.set(frame.id, controller)
    try {
      const payload = frame.payload
      let value: unknown
      switch (frame.command) {
        case 'setProxy':
          value = await runtime.setProxy(
            typeof payload.proxyUrl === 'string' ? payload.proxyUrl : undefined,
            controller.signal
          )
          break
        case 'fetchPage':
          value = await runtime.fetchPage(
            String(payload.url ?? ''),
            payload.options && typeof payload.options === 'object'
              ? (payload.options as Parameters<typeof runtime.fetchPage>[1])
              : undefined,
            controller.signal
          )
          if (payload.discardBody === true) value = true
          break
        case 'fetchBuffer':
          value = await runtime.fetchBuffer(
            String(payload.url ?? ''),
            payload.options && typeof payload.options === 'object'
              ? (payload.options as Parameters<typeof runtime.fetchBuffer>[1])
              : undefined,
            controller.signal
          )
          break
        case 'fetchBufferResponse':
          value = await runtime.fetchBufferResponse(
            String(payload.url ?? ''),
            payload.options && typeof payload.options === 'object'
              ? (payload.options as Parameters<typeof runtime.fetchBufferResponse>[1])
              : undefined,
            controller.signal
          )
          break
        case 'performAction':
          value = await runtime.performAction(
            String(payload.action ?? ''),
            payload.params && typeof payload.params === 'object'
              ? (payload.params as Record<string, unknown>)
              : undefined,
            controller.signal
          )
          break
        case 'shutdown':
          value = true
          break
      }
      if (requests.get(frame.id) !== controller) return
      framed.send({ type: 'response', id: frame.id, ok: true, value })
      if (frame.command === 'shutdown') setImmediate(shutdown)
    } catch (error) {
      if (requests.get(frame.id) !== controller) return
      framed.send({ type: 'response', id: frame.id, ok: false, error: errorShape(error) })
    } finally {
      requests.delete(frame.id)
    }
  }

  const onFrame = (frame: ScrapeBrowserProtocolFrame): void => {
    if (frame.type === 'request') {
      void respond(frame)
      return
    }
    if (frame.type === 'cancel') {
      requests.get(frame.id)?.abort(new Error(frame.reason || 'Browser request cancelled'))
    }
  }

  framed = new ScrapeBrowserFramedSocket(socket, onFrame, () => shutdown())
  socket.once('close', shutdown)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const { targetId } = await runtime.initialize()
  framed.send({
    type: 'hello',
    protocolVersion: SCRAPE_BROWSER_PROTOCOL_VERSION,
    token: env.token,
    pid: process.pid,
    parentPid: env.parentPid,
    cdpPort: env.cdpPort,
    targetId
  })

  const parentWatch = setInterval(() => {
    if (!assertParentAlive(env.parentPid)) shutdown()
  }, 2000)
  parentWatch.unref()
  app.once('before-quit', () => clearInterval(parentWatch))
}
