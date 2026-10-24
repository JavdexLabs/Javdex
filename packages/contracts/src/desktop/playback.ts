/** Desktop only. Locators, grants and arbitrary mpv commands never cross this interface. */
export type PlaybackPresentation = 'expanded' | 'docked' | 'fullscreen'
/** Drawing path; GPU output may still use software video decoding. */
export type PlaybackRenderMode = 'auto' | 'gpu' | 'cpu'
export interface PlaybackTarget {
  libraryId: number
  videoId: number
  resourceId: number
}
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
  /** Shared Canvas generation. Never a locator or platform GPU handle. */
  sharedTextureSurface?: string
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
    playbackMode?: 'gpu' | 'cpu'
    playbackFallback?: boolean
    playbackDiagnostics?: {
      decoding: 'hardware' | 'software' | 'unknown'
      /** Observed hardware-to-software transition, not a diagnosis of its cause. */
      decoderFallback: boolean
      displayProbe: 'pending' | 'passed' | 'not-applicable'
      fallbackReason: string | null
    }
    hardwareDecoder: string | null
    audioOutput: string | null
    droppedFrames: number | null
  }
}
/** Main-process publication order, including stopped/null states and replacement sessions. */
export interface PlaybackObservation { revision: number; snapshot: PlaybackSnapshot | null }
export interface PlaybackAvailability { available: boolean; reason: string | null }
