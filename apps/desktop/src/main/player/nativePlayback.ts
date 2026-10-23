import type { PlaybackControl, PlaybackOcclusion, PlaybackSnapshot } from '@shared/desktop/playback'

/** Private seam: renderer cannot see this interface or call native commands. */
export interface NativePlaybackState {
  alive: boolean
  playbackMode?: 'gpu' | 'cpu'
  playbackFallback?: boolean
  playbackFallbackReason?: string
  decoderFallback?: boolean
  displayProbe?: 'pending' | 'passed' | 'not-applicable'
  rendererFullscreenControls?: boolean
  /** Main-owned shared-texture generation, never a media locator or native FD. */
  sharedTextureSurface?: string
  nativeVideoFocused?: boolean
  interactionSequence?: number
  fullscreenPointerY?: number
  nativeFrames?: number
  /** New-frame swaps submitted while the surface is visible; not screen capture proof. */
  presentedFrames?: number
  /** Shared Canvas submission only; physical presentation feedback unavailable. */
  submittedFrames?: number
  frameTimeline?: number
  renderBudgetMs?: number
  submissionLatenessMs?: number
  loadedFiles?: number
  subtitleCommandErrors?: number
  generatedSubtitleCommandErrors?: number
  generatedSubtitleCommandsPending?: number
  generatedSubtitleCommandReplies?: number
  generatedSubtitleOverlayVersion?: number
  generatedSubtitleRevision?: number
  subtitleCommandsPending?: number
  subtitleCommandReplies?: number
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
  sid?: string
  aid?: string
  'chapter-list'?: string
  actions?: Array<{ kind: 'toggle-pause' | 'toggle-mute' | 'expand' | 'dock' | 'fullscreen' | 'stop' | 'seek' | 'seek-relative' | 'volume' | 'volume-relative' | 'focus-forward' | 'focus-backward' | 'history-back' | 'history-forward' | 'escape'; value?: number }>
}
export interface NativePlayback {
  /** False only for a self-driven host; normal state/fault observation remains. */
  renderPolling?: boolean
  create(): void
  load(locator: string, options?: { paused: boolean }): void
  command(command: PlaybackControl): void
  read(): NativePlaybackState
  viewport(rect: { x: number; y: number; width: number; height: number }, visible: boolean, state: PlaybackSnapshot,
    occlusions?: PlaybackOcclusion[]): void
  render(): void
  addSubtitle(file: string): void
  /** Main-owned ASS timeline and logical file identity; native display never reloads that file. */
  updateGeneratedSubtitle?(file: string, select: boolean, signal: AbortSignal | undefined, document: string): void | Promise<void>
  removeGeneratedSubtitle?(file: string, restoreId: number | null): void | Promise<void>
  generatedSubtitleSelected?(file: string): boolean
  selectedAudioStream?(): number | null
  /** Non-consuming optional-command counter; never drains playback input. */
  subtitleCommandErrors?(): number
  generatedSubtitleCommandErrors?(): number
  destroy(): void
}
