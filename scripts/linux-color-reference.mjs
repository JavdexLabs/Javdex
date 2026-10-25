// ST 2084 inverse EOTF: absolute display luminance (cd/m²) to PQ code.
export function pqCode(nits) {
  const p = (nits / 10000) ** (2610 / 16384)
  return ((3424 / 4096 + (2413 / 128) * p) / (1 + (2392 / 128) * p)) ** (2523 / 32)
}

// BT.2100 HLG: neutral patches, nominal 1000 cd/m² display, system gamma 1.2.
export function hlgCode(nits) {
  const scene = (nits / 1000) ** (1 / 1.2)
  return scene <= 1 / 12 ? Math.sqrt(3 * scene)
    : 0.17883277 * Math.log(12 * scene - 0.28466892) + 0.55991073
}
