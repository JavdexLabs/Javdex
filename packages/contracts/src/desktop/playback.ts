/** Desktop only. Locators, grants and arbitrary mpv commands never cross this interface. */
export type PlaybackPresentation = 'expanded' | 'docked' | 'fullscreen'
export interface PlaybackTarget {
  libraryId: number
  videoId: number
  resourceId: number
}
export interface PlaybackOpenOptions { privateSession?: boolean }
export type PlaybackClearProgress = { scope: 'all' } | { scope: 'current'; sessionId: string }
export interface PlaybackViewport {
  sessionId: string
  presentationRevision: number
  sequence: number
  presentation: PlaybackPresentation
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
}
export type PlaybackControl =
  | { kind: 'pause'; paused: boolean }
  | { kind: 'seek'; seconds: number; relative?: boolean }
  | { kind: 'volume'; value: number }
  | { kind: 'mute'; muted: boolean }
  | { kind: 'speed'; value: number }
  | { kind: 'track'; type: 'audio' | 'sub'; id: number | null }
  | { kind: 'subtitle-delay'; seconds: number }
  | { kind: 'subtitle-size'; value: number }
  | { kind: 'presentation'; value: PlaybackPresentation }
  | { kind: 'restart' }
  | { kind: 'resume'; choice: 'continue' | 'start' }
  | { kind: 'private-session' }
  | { kind: 'stop' }
export interface PlaybackTrack {
  id: number
  type: 'audio' | 'sub'
  title: string | null
  language: string | null
  codec: string | null
  /** Container metadata hint, not decoded channels or the device output layout. */
  channelCountHint: number | null
  selected: boolean
}
export interface PlaybackSnapshot {
  sessionId: string
  target: PlaybackTarget
  title: string
  source: 'local' | 'remote'
  presentation: PlaybackPresentation
  presentationRevision: number
  phase: 'opening' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'
  /** Transient native-to-HTML keyboard handoff; never persisted. */
  focusRequest?: { sequence: number; backwards: boolean }
  paused: boolean
  seeking: boolean
  position: number | null
  duration: number | null
  seekable: boolean
  volume: number
  muted: boolean
  speed: number
  subtitleDelay: number | null
  subtitleSize: number | null
  tracks: PlaybackTrack[]
  chapters: Array<{ title: string; time: number }>
  error: string | null
  resumePosition: number | null
  recordingProgress: boolean
  progressError: string | null
  info: {
    videoCodec: string | null
    audioCodec: string | null
    width: number | null
    height: number | null
    hardwareDecoder: string | null
    audioOutput: string | null
    droppedFrames: number | null
  }
}
export interface PlaybackAvailability { available: boolean; reason: string | null }
