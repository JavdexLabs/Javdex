import { createServer as createTcpServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer, type RequestListener } from 'node:http'
import { createServer as createHttpsServer, type ServerOptions } from 'node:https'

/** One public listener; protocol comes from the wire, never from forwarding headers. */
export function createDualProtocolServer(tls: ServerOptions, listener: RequestListener): Server & { closeAllConnections(): void } {
  const http = createHttpServer(listener)
  const https = createHttpsServer({ ...tls, handshakeTimeout: 15_000 }, listener)
  for (const parser of [http, https]) {
    parser.requestTimeout = 120_000
    parser.headersTimeout = 15_000
    parser.on('upgrade', (_request, socket) => socket.destroy())
  }
  const sockets = new Set<Socket>()
  const server = createTcpServer(socket => {
    sockets.add(socket)
    // Bound clients that connect without sending a protocol prefix.
    const timeout = setTimeout(() => socket.destroy(), 15_000).unref()
    socket.on('error', () => {})
    socket.once('close', () => { clearTimeout(timeout); sockets.delete(socket) })
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(timeout)
      socket.pause()
      socket.unshift(chunk)
      if (chunk[0] === 0x16) {
        // TLSSocket drains the parent's buffered ClientHello before reading more.
        https.emit('connection', socket)
      } else if (chunk[0] >= 0x41 && chunk[0] <= 0x5a) {
        http.emit('connection', socket)
        socket.resume()
      } else socket.destroy()
    })
  })
  // These parsers do not bind their own ports. Forward lifecycle events so Node
  // starts its header/body deadline checks and releases their timers on shutdown.
  server.on('listening', () => { http.emit('listening'); https.emit('listening') })
  server.on('close', () => { http.close(() => {}); https.close(() => {}) })
  server.maxConnections = 128
  return Object.assign(server, { closeAllConnections() { for (const socket of sockets) socket.destroy() } })
}
