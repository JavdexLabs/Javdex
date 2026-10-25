/** Only the engine's native hardware enumeration qualifies an audio.cpp device. */
export function parseAudioCppVulkanDevices(output: string, diagnostic: string): Array<{ index: number; name: string; integrated?: boolean }> {
  return [...output.matchAll(/^Vulkan:(\d+) "(.+)" \[(GPU|IGPU)\]\s*$/gm)].flatMap(([, index, name, kind]) => {
    if (/llvmpipe|lavapipe|swiftshader|software|virtual/i.test(name)) return []
    const line = diagnostic.split('\n').find(line => line.includes(name) && /\| uma: [01]\b/.test(line))
    if (!line) return []
    const integrated = /\| uma: 1\b/.test(line)
    if (kind === 'IGPU' && !integrated) return []
    return [{ index: Number(index), name, ...(integrated ? { integrated: true } : {}) }]
  })
}
