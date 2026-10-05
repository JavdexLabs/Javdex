import type { PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'

/** Private seam: renderer cannot see this interface or call native commands. */
export interface NativePlaybackState {
  alive: boolean
  rendererFullscreenControls?: boolean
  nativeVideoFocused?: boolean
  interactionSequence?: number
  fullscreenPointerY?: number
  nativeFrames?: number
  /** New-frame swaps submitted while the surface is visible; not screen capture proof. */
  presentedFrames?: number
  loadedFiles?: number
  error?: string
  errorKind?: 'format' | 'streams' | 'audio' | 'video' | 'load' | 'native'
  pause?: boolean
  mute?: boolean
  seekable?: boolean
  seeking?: boolean
  'paused-for-cache'?: boolean
  'eof-reached'?: boolean
  'time-pos'?: number
  duration?: number
  volume?: number
  speed?: number
  'sub-delay'?: number
  'sub-font-size'?: number
  width?: number
  height?: number
  'video-codec'?: string
  'audio-codec'?: string
  'hwdec-current'?: string
  'current-ao'?: string
  'frame-drop-count'?: number
  'track-list'?: string
  'chapter-list'?: string
  actions?: Array<{ kind: 'toggle-pause' | 'toggle-mute' | 'expand' | 'dock' | 'fullscreen' | 'stop' | 'seek' | 'seek-relative' | 'volume' | 'volume-relative' | 'focus-forward' | 'focus-backward' | 'history-back' | 'history-forward'; value?: number }>
}
export interface NativePlayback {
  create(): void
  load(locator: string, options?: { paused: boolean }): void
  command(command: PlaybackControl): void
  read(): NativePlaybackState
  viewport(rect: { x: number; y: number; width: number; height: number }, visible: boolean, state: PlaybackSnapshot,
    occlusions?: Array<{ x: number; y: number; width: number; height: number }>): void
  render(): void
  addSubtitle(file: string): void
  destroy(): void
}
