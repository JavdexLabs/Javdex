import { Worker } from 'node:worker_threads'

/** Production worker entry path is supplied by the application, never by an IPC caller. */
export function createCatalogReadWorkerTransport(entryPath: string, databasePath: string): Worker {
  const worker = new Worker(entryPath, { workerData: { databasePath }, execArgv: [] })
  const terminateNative = worker.terminate.bind(worker)
  // Keep an error listener during retirement even after the client detaches its own.
  worker.on('error', () => {})
  let retirement: Promise<number> | undefined
  worker.terminate = () => {
    if (retirement) return retirement
    retirement = new Promise<number>((resolve, reject) => {
      if (worker.threadId === -1) { resolve(0); return }
      const finish = (code: number): void => {
        if (timer) clearTimeout(timer)
        worker.off('exit', finish)
        resolve(code)
      }
      const fail = (error: unknown): void => {
        if (timer) clearTimeout(timer)
        worker.off('exit', finish)
        reject(error)
      }
      worker.once('exit', finish)
      // A close message releases SQLite normally when the current synchronous
      // read ends. Native termination is the fallback, not a SQLite interrupt.
      const timer = setTimeout(() => { void terminateNative().then(finish, fail) }, 1000)
      try { worker.postMessage({ type: 'close' }) }
      catch { void terminateNative().then(finish, fail) }
    })
    return retirement
  }
  return worker
}
