import type { BrowserWindow } from 'electron'
import { createSoftwarePlaybackBridge, type SoftwareProducer } from './softwarePlayback'

export type WindowsSoftwareProducer = SoftwareProducer
export function createWindowsSoftwarePlaybackBridge(native: WindowsSoftwareProducer, window: BrowserWindow) {
  return createSoftwarePlaybackBridge(native, window, 'win32')
}
