import { createRequire } from 'node:module'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

if (!parentPort || process.platform !== 'win32' || typeof workerData !== 'string'
  || !path.isAbsolute(workerData) || path.basename(workerData) !== 'playback-interop.node') {
  throw new Error('Invalid playback interop worker invocation')
}

// Only map the DLL. The main thread owns every acquire/release call and the
// module's native handle set. Keep our DLL reference until main has bound it.
createRequire(import.meta.url)(workerData)
parentPort.ref()
parentPort.postMessage('ready')
