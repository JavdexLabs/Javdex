// Independent luminance reference for captured SDR bytes, not product code.
// ST 2084 and the zero-black BT.2390 Hermite EETF (mpv vo_gpu's fixed curve).
import { pqCode } from './linux-color-reference.mjs'

export function pqLuminance(code) {
  const p = Math.max(0, code) ** (32 / 2523)
  return 10000 * (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (16384 / 2610)
}

export function hlgLuminance(code) {
  const scene = code <= 0.5 ? code * code / 3
    : (Math.exp((code - 0.55991073) / 0.17883277) + 0.28466892) / 12
  return 1000 * scene ** 1.2
}

export function bt2390Srgb(nits, sourcePeak, targetPeak = 203) {
  if (sourcePeak <= targetPeak) return srgbByte(nits / targetPeak)
  const peak = pqCode(sourcePeak), maximum = pqCode(targetPeak) / peak
  const knee = 1.5 * maximum - 0.5
  let signal = pqCode(Math.min(nits, sourcePeak)) / peak
  if (signal >= knee) {
    const t = (signal - knee) / (1 - knee), t2 = t * t, t3 = t2 * t
    signal = (2 * t3 - 3 * t2 + 1) * knee + (t3 - 2 * t2 + t) * (1 - knee)
      + (-2 * t3 + 3 * t2) * maximum
  }
  return srgbByte(pqLuminance(signal * peak) / targetPeak)
}

// mpv's GPU renderer treats tagged BT.709 video as a BT.1886 display signal.
export function bt1886Srgb(code) {
  return srgbByte(code ** 2.4)
}

function srgbByte(linear) {
  linear = Math.max(0, Math.min(1, linear))
  return 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055)
}
