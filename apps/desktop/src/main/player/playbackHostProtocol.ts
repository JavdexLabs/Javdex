import type { NativePlaybackState } from './nativePlayback'

export interface HostBounds { width: number; height: number; scale?: number }
export interface WindowsPlaybackAdapter {
  vendorId: number; deviceId: number; gpuPreference?: 2 | 3
  adapterLuidLow?: number; adapterLuidHigh?: number
}
export interface HostFrame {
  sequence: number; cpuChannelId?: string; width: number; height: number; stride?: number; size?: number; pixels?: Uint8Array
  timeline?: number; ntHandle?: Uint8Array; ioSurface?: Uint8Array
  slot?: number; resourceId?: number
  pixelFormat?: string; producerComplete?: boolean; colorContract?: string
  renderStartUs?: number; targetTimeUs?: number; delayUs?: number; selfTest?: 'solid-v1'
}
export type HostRequest =
  | { type: 'cpu-frame-port'; cpuChannelId: string }
  | { type: 'cpu-frame-detached'; cpuChannelId: string }
  | { type: 'create'; bounds: HostBounds; windowsAdapter?: WindowsPlaybackAdapter }
  | { type: 'bounds'; bounds: HostBounds }
  | { type: 'visible'; value: boolean }
  | { type: 'command'; args: string[]; generated: boolean }
  | { type: 'subtitles'; operation: 'update' | 'visible' | 'clear'; document: string; visible: boolean; revision: number }
  | { type: 'release'; sequence: number }
  | { type: 'timing'; timeline: number }
  | { type: 'budget'; milliseconds: number }
  | { type: 'destroy' }
  | { type: 'stall' }
  | { type: 'probe' }
export type HostResponse =
  | { type: 'ready' }
  | { type: 'cpu-frame-port-closed'; cpuChannelId: string }
  | { type: 'ack' }
  | { type: 'state'; state: NativePlaybackState }
  | { type: 'frame'; frame: HostFrame }
  | { type: 'failed' }

/** Private copied CPU pixels. The main process authenticates the display binding
 * and forwards metadata; this port is never exposed through the renderer API. */
export interface CpuFrameBinding { surfaceToken: string; bindingToken: string }
export interface CpuFramePortBinding extends CpuFrameBinding { cpuChannelId: string }
export interface CpuFramePixels { cpuChannelId: string; sequence: number; timeline: number; pixels: Uint8Array }
export interface CpuFrameRetirement { type: 'retired'; cpuChannelId: string; sequence: number }
export type CpuFramePortMessage = CpuFramePixels | CpuFrameRetirement
export interface CpuFrameEnvelope extends CpuFramePortBinding {
  sequence: number; timeline: number; width: number; height: number; stride: number; size: number
  targetTime?: number; renderStartUs?: number
}
