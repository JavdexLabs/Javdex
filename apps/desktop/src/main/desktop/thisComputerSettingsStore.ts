import fs from 'node:fs'
import path from 'node:path'
import type { ThisComputerSettings } from '@shared/desktop/settings'
import type { DesktopSettingsStore } from '../application/desktopPorts'

export const DEFAULT_THIS_COMPUTER_SETTINGS: ThisComputerSettings = {
  mode: 'local',
  remoteBaseUrl: null,
  closeToTray: false,
  theme: 'graphite',
  playerPath: null,
  playerPreference: 'builtin',
  playbackVolume: 50,
  resumePlayback: false,
  proxyUrl: '',
  proxyUrlEnabled: false,
  llmProxyUrl: '',
  llmProxyUrlEnabled: false
}

function normalized(value: Partial<ThisComputerSettings>): ThisComputerSettings {
  const mode = value.mode === 'remote' ? 'remote' : 'local'
  const remoteBaseUrl =
    typeof value.remoteBaseUrl === 'string' && value.remoteBaseUrl.trim()
      ? value.remoteBaseUrl.trim()
      : null
  return {
    mode,
    remoteBaseUrl,
    closeToTray: value.closeToTray === true,
    theme: typeof value.theme === 'string' && value.theme.trim() ? value.theme.trim() : 'graphite',
    playerPath:
      typeof value.playerPath === 'string' && value.playerPath.trim() ? value.playerPath.trim() : null,
    // Legacy settings without a preference retain external playback; only fresh defaults use builtin.
    playerPreference: value.playerPreference === 'builtin' ? 'builtin' : 'external',
    playbackVolume: typeof value.playbackVolume === 'number' && Number.isFinite(value.playbackVolume)
      ? Math.max(0, Math.min(100, value.playbackVolume)) : 50,
    resumePlayback: value.resumePlayback === true,
    proxyUrl: typeof value.proxyUrl === 'string' ? value.proxyUrl : '',
    proxyUrlEnabled: value.proxyUrlEnabled === true,
    llmProxyUrl: typeof value.llmProxyUrl === 'string' ? value.llmProxyUrl : '',
    llmProxyUrlEnabled: value.llmProxyUrlEnabled === true
  }
}

export function thisComputerSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, 'this-computer.json')
}

export function createThisComputerSettingsStore(filePath: string): DesktopSettingsStore {
  const listeners = new Set<(settings: ThisComputerSettings) => void>()
  const readSync = (): ThisComputerSettings => {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      return normalized(JSON.parse(raw) as Partial<ThisComputerSettings>)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...DEFAULT_THIS_COMPUTER_SETTINGS }
      }
      throw error
    }
  }

  return {
    async read(): Promise<ThisComputerSettings> {
      return readSync()
    },
    async write(patch): Promise<ThisComputerSettings> {
      const next = normalized({ ...readSync(), ...patch })
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const temp = `${filePath}.tmp-${process.pid}`
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, filePath)
      for (const listener of listeners) {
        try { listener({ ...next }) } catch { console.warn('[this-computer] settings listener failed') }
      }
      return next
    },
    onChanged(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  }
}
