import type { WindowsPlaybackAdapter } from './playbackHostProtocol'

/** GPUInfo omits the Windows LUID. The native host resolves the reported
 * low/high-power preference through DXGI, then verifies this PCI identity.
 * Without a preference it must prove the PCI match is unique. */
export function selectWindowsPlaybackAdapter(value: unknown): WindowsPlaybackAdapter | undefined {
  const info = value as { gpuDevice?: Array<Record<string, unknown>> } | null
  if (!Array.isArray(info?.gpuDevice)) return
  const active = info.gpuDevice.filter(device => device?.active === true)
  if (active.length !== 1) return
  const { vendorId, deviceId } = active[0]
  if (typeof vendorId !== 'number' || typeof deviceId !== 'number'
    || !Number.isInteger(vendorId) || !Number.isInteger(deviceId)
    || vendorId <= 0 || vendorId > 0xffff || deviceId <= 0 || deviceId > 0xffff
    || vendorId === 0x1414) return // Microsoft software renderer has no hardware target.
  const preference = active[0].gpuPreference
  return { vendorId, deviceId, ...(preference === 2 || preference === 3 ? { gpuPreference: preference } : {}) }
}
