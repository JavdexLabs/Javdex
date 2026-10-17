import { randomInt } from 'node:crypto'
import type { Server } from 'node:net'

/** Bind a real Fetch fixture above the Fetch Standard's blocked ports (currently <= 10080).
 * Port 0 is unsafe when a host's configured dynamic range includes those ports.
 * Keep the selected socket open; reserving and releasing a port creates a race.
 */
export async function listenFetchServer(server: Server): Promise<number> {
  return startFetchServer((port) => new Promise<number>((resolve, reject) => {
    const cleanup = (): void => { server.off('error', failed); server.off('listening', listening) }
    const failed = (error: Error): void => { cleanup(); reject(error) }
    const listening = (): void => {
      cleanup()
      const address = server.address()
      if (address && typeof address !== 'string') resolve(address.port)
      else reject(new Error('HTTP test fixture did not bind a TCP port'))
    }
    server.once('error', failed)
    server.once('listening', listening)
    try { server.listen(port, '127.0.0.1') }
    catch (error) { cleanup(); reject(error) }
  }))
}

/** For wrappers such as WebServer that own their listening socket. The callback must bind it directly. */
export async function startFetchServer(start: (port: number) => Promise<number>): Promise<number> {
  let lastError: unknown
  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      return await start(randomInt(49152, 65536))
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      lastError = error
    }
  }
  throw new Error('Unable to bind a Fetch-compatible HTTP test port after 32 attempts', { cause: lastError })
}
