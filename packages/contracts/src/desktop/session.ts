export type DesktopSessionState =
  | 'starting'
  | 'available'
  | 'disconnected'
  | 'authInvalid'
  | 'versionMismatch'
  | 'recoveryRequired'
  | 'frozen'
  | 'modePrepRequired'

export interface DesktopSession {
  state: DesktopSessionState
  mode: 'local' | 'remote'
  catalogId: string | null
  serverId: string | null
  generation: number
  writerEpoch: number | null
  frozen: boolean
  appVersion: string | null
  schemaVersion: number | null
  message: string | null
}

export const EMPTY_DESKTOP_SESSION: DesktopSession = {
  state: 'starting',
  mode: 'local',
  catalogId: null,
  serverId: null,
  generation: 0,
  writerEpoch: null,
  frozen: false,
  appVersion: null,
  schemaVersion: null,
  message: null
}
