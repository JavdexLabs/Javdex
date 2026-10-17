import { setTimeout as delay } from 'node:timers/promises'
import { atomicWrite } from '../../utils/atomicWrite'

/** mpv briefly opens ASS files without delete sharing on Windows. */
export async function writeSubtitleFile(filename: string, document: string, signal: AbortSignal): Promise<void> {
  const waits = [25, 50, 100, 200, 400]
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try {
      await atomicWrite(filename, document)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= waits.length) throw error
      // Keep the previous complete file while the reader releases its handle.
      await delay(waits[attempt], undefined, { signal })
    }
  }
}
