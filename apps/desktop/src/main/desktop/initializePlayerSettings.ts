import type { DefaultPlayerDetectionResult } from '@shared/desktop/settings'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { detectDefaultPlayer } from './defaultPlayerService'

/** Fill an unconfigured program path before the desktop starts serving settings. */
export async function initializePlayerSettings(
  settings: DesktopSettingsStore,
  detect: () => Promise<DefaultPlayerDetectionResult> = detectDefaultPlayer
): Promise<void> {
  if ((await settings.read()).playerPath) return
  let result: DefaultPlayerDetectionResult
  try {
    result = await detect()
  } catch {
    return
  }
  if (result.status !== 'found' || !result.path.trim()) return
  // Detection is asynchronous; preserve a program selected while it was pending.
  if ((await settings.read()).playerPath) return
  await settings.write({ playerPath: result.path })
}
