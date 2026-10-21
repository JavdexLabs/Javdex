import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export const EXPERIMENTAL_LINUX_NAME = 'Javdex Linux Texture Experimental'
export const EXPERIMENTAL_LINUX_PROFILE = 'Javdex-Linux-Texture-Experimental'

/** Packaging-only marker: ordinary development/release builds keep their identity. */
export function isExperimentalLinuxBuild(packageName?: string): boolean {
  if (process.platform !== 'linux' || !app.isPackaged) return false
  try {
    const metadata: unknown = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    return Boolean(metadata && typeof metadata === 'object'
      && (metadata as Record<string, unknown>).javdexExperimentalLinux === true
      && (!packageName || (metadata as Record<string, unknown>).name === packageName))
  } catch { return false }
}
