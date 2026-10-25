const reasons = new Set(['GPU_DISABLED', 'GPU_INITIALIZATION_FAILED', 'GPU_RUNTIME_FAILED',
  'DISPLAY_SELF_TEST_FAILED', 'DISPLAY_SELF_TEST_TIMEOUT', 'DRM_RENDER_NODE_UNAVAILABLE',
  'GBM_LINEAR_BUFFER_UNAVAILABLE', 'EGL_DMABUF_UNAVAILABLE', 'VULKAN_DMABUF_UNAVAILABLE',
  'FRAME_RENDER_FAILED', 'TEXTURE_IMPORT_FAILED', 'RECEIVER_NOT_READY', 'FRAME_RELEASE_TIMEOUT',
  'HELPER_HEARTBEAT_TIMEOUT', 'GPU_PROCESS_EXITED', 'PLAYBACK_HOST_EXITED', 'FRAME_CHANNEL_FAILED', 'EXPERIMENTAL_PLAYBACK_FAILED'])

export function graphicsPlaybackFailure(code: string): Error {
  return Object.assign(new Error('播放画面通路不可用'), { playbackFailureKind: 'graphics',
    playbackFailureCode: reasons.has(code) ? code : 'GPU_RUNTIME_FAILED' })
}

/** Fixed machine diagnostics only; native strings and locators stay private. */
export function isGraphicsPlaybackFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const value = error as Error & { playbackFailureKind?: unknown; playbackFailureCode?: unknown }
  if (value.playbackFailureKind !== undefined) return value.playbackFailureKind === 'graphics'
  if (typeof value.playbackFailureCode === 'string') return reasons.has(value.playbackFailureCode)
  return false
}

export function playbackFallbackReason(error: unknown, fallback: string): string {
  const code = (error as { playbackFailureCode?: unknown } | null)?.playbackFailureCode
  return typeof code === 'string' && reasons.has(code) ? code : fallback
}
