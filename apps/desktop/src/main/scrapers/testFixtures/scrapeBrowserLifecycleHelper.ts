import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import {
  SCRAPE_BROWSER_HELPER_ENV as env,
  SCRAPE_BROWSER_PROTOCOL_VERSION,
  ScrapeBrowserFramedSocket
} from '../scrapeBrowserProtocol'

async function main(): Promise<void> {
  const cdpPort = Number(process.env[env.cdpPort])
  const socket = net.createConnection(process.env[env.pipe]!)
  const framed = new ScrapeBrowserFramedSocket(socket, (frame) => {
    if (frame.type !== 'request') return
    if (frame.command === 'fetchPage' && frame.payload.url === 'https://example.test/disconnect') {
      socket.destroy()
      return
    }
    framed.send({
      type: 'response',
      id: frame.id,
      ok: true,
      value: frame.command === 'fetchPage' ? '<main>fixture</main>' : true
    })
    if (frame.command === 'shutdown') process.exit(0)
  }, () => {})
  const cdp = http.createServer((_request, response) => {
    if (process.env.JAVDEX_FIXTURE_DISCONNECT_DURING_STARTUP === '1') {
      // Keep both the process and the CDP request alive after the control socket closes.
      socket.destroy()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify([{ type: 'page', id: 'fixture-page' }]))
  })
  const connected = once(socket, 'connect')
  cdp.listen(cdpPort, '127.0.0.1')
  await Promise.all([connected, once(cdp, 'listening')])
  framed.send({
    type: 'hello',
    protocolVersion: SCRAPE_BROWSER_PROTOCOL_VERSION,
    token: process.env[env.token]!,
    parentPid: Number(process.env[env.parentPid]),
    pid: process.pid,
    cdpPort,
    targetId: 'fixture-page'
  })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
