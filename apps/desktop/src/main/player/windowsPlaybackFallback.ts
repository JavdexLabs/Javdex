import type { NativePlayback } from './nativePlayback'
import { createGraphicsPlaybackFallback } from './graphicsPlaybackFallback'

export function createWindowsPlaybackFallback(gpu: NativePlayback, cpu: NativePlayback,
  options: { forceCpu(): boolean; gpuAvailable(): boolean }): NativePlayback {
  return createGraphicsPlaybackFallback(gpu, cpu, options, 'win32')
}
