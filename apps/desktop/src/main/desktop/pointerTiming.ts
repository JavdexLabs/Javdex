import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fallbackPointerTiming, type PointerTiming } from '@shared/desktop/input'

const runFile = promisify(execFile)
export const macPointerTimingQuery = 'ObjC.import("AppKit"); $.NSEvent.doubleClickInterval'

async function queryMacInterval(): Promise<string> {
  // A fixed read-only AppKit query using the OS interpreter; no shell, native
  // playback library, automation permission or user-supplied program is needed.
  const { stdout } = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macPointerTimingQuery], {
    timeout: 2000, maxBuffer: 1024, encoding: 'utf8'
  })
  return stdout
}

export async function readPointerTiming(platform = process.platform, query = queryMacInterval): Promise<PointerTiming> {
  // Electron 43 / Chromium 150 Aura constructs ui::MouseEvent on both Windows
  // and Linux. GetRepeatCount uses kDoubleClickTimeMs=500, not the OS setting.
  if (platform === 'linux' || platform === 'win32') return { doubleClickMs: 500, source: 'chromium' }
  if (platform === 'darwin') {
    try {
      const raw = (await query()).trim()
      const milliseconds = Number(raw) * 1000
      if (raw && Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 5000)
        return { doubleClickMs: Math.ceil(milliseconds), source: 'system' }
    } catch { /* Use a bounded conservative deadline, keeping explicit controls immediate. */ }
  }
  return { ...fallbackPointerTiming }
}
