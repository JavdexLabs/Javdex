import type { DesktopCapabilityMap } from './capabilities'
import type { WriterClaimKind, WriterClaimResult } from '../protocol/writer'

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

export interface DesktopSessionSnapshot {
  session: DesktopSession
  capabilities: DesktopCapabilityMap
}

export interface DesktopWriterClaimRequest {
  kind: WriterClaimKind
  oneTimeToken: string
}

export type DesktopWriterClaimResult = WriterClaimResult

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

/** Used when preload session APIs are absent (renderer tests). */
export const ASSUMED_LOCAL_SESSION: DesktopSession = {
  ...EMPTY_DESKTOP_SESSION,
  state: 'available',
  generation: 1
}

export function sessionAllowsCatalogReads(session: DesktopSession): boolean {
  return session.state === 'available' || session.state === 'frozen'
}
