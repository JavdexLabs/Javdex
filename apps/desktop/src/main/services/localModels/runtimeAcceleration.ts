import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalAccelerationPolicy, LocalExecutionStatus, LocalGpuDevice } from '@shared/desktop/localModels'
import { runLocalModelProcess } from './processRunner'

export type LocalEngine = 'recognition' | 'translation'
export interface LocalGpuRuntime { translator?: string; whisper?: string; audiocpp?: string; libraryDirectory?: string }
export interface LocalRuntimeAcceleration {
  policy: LocalAccelerationPolicy
  devices: LocalGpuDevice[]
  runtimes: Partial<Record<'cuda' | 'vulkan', LocalGpuRuntime>>
  status?: (engine: LocalEngine, status: LocalExecutionStatus) => void
}
export interface LocalExecution {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  backend: LocalExecutionStatus['backend']
  device?: LocalGpuDevice
  reason?: string
  release: () => void
}
export class LocalGpuFailure extends Error {}
const reservations = new Map<string, number>()

/** Audio and text engines share the same conservative per-card budget. */
export function reserveLocalGpuMemory(name: string, memoryMiB: number, requiredMiB: number): (() => void) | null {
  const used = reservations.get(name) ?? 0
  if (requiredMiB > memoryMiB - 2048 - used) return null
  reservations.set(name, used + requiredMiB)
  let released = false
  return () => { if (!released) { released = true; reservations.set(name, Math.max(0, (reservations.get(name) ?? 0) - requiredMiB)) } }
}

/** Only native backend enumeration can qualify a device. Virtual/UMA adapters are excluded. */
export function parseVulkanDevices(stdout: string, diagnostic: string): LocalGpuDevice[] {
  return [...stdout.matchAll(/^\s*Vulkan(\d+): (.+?) \((\d+) MiB,/gm)].flatMap(match => {
    const [, index, name, memory] = match
    const discrete = diagnostic.split('\n').some(line => line.includes(name) && /\| uma: 0\b/.test(line))
    return discrete ? [{ id: `vulkan:${index}:${name}`, backend: 'vulkan' as const, index: Number(index), name, memoryMiB: Number(memory) }] : []
  })
}
export async function detectLocalGpuDevices(vulkan?: LocalGpuRuntime): Promise<LocalGpuDevice[]> {
  if (process.platform !== 'win32') return []
  const devices: LocalGpuDevice[] = []
  try {
    const output = await runLocalModelProcess('nvidia-smi', ['--query-gpu=uuid,name,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 10000, maxBytes: 65536 })
    for (const [index, line] of output.trim().split('\n').entries()) {
      const [id, name, memory] = line.split(',').map(value => value.trim())
      if (/^GPU-[a-f0-9-]+$/i.test(id) && name && Number(memory) > 0) devices.push({ id, name, backend: 'cuda', index, memoryMiB: Number(memory) })
    }
  } catch { /* Missing NVIDIA tools or a broken driver is an ordinary CPU-only host. */ }
  if (vulkan?.translator) {
    try {
      let diagnostic = ''
      const output = await runLocalModelProcess(vulkan.translator, ['--log-verbosity', '5', '--list-devices'], {
        timeoutMs: 15000, maxBytes: 65536, diagnostic: value => { diagnostic = value }
      })
      devices.push(...parseVulkanDevices(output, diagnostic))
    } catch { /* A loader/driver failure must not prevent CPU use. */ }
  }
  return devices
}
export function cpuExecution(executable: string, engine: LocalEngine, acceleration?: LocalRuntimeAcceleration, reason?: string): LocalExecution {
  acceleration?.status?.(engine, { backend: 'cpu', reason })
  return { executable, backend: 'cpu', reason, env: {}, release: () => {},
    args: engine === 'translation' ? ['--device', 'none', '--gpu-layers', '0'] : ['--no-gpu'] }
}
export async function selectLocalExecution(executable: string, model: string, engine: LocalEngine, acceleration?: LocalRuntimeAcceleration): Promise<LocalExecution> {
  if (process.platform === 'darwin' && (!acceleration || acceleration.policy.mode === 'auto')) {
    return { executable, backend: 'metal', env: {}, release: () => {}, args: engine === 'translation' ? ['--log-verbosity', '4'] : [] }
  }
  if (!acceleration || process.platform !== 'win32' || acceleration.policy.mode === 'cpu') return cpuExecution(executable, engine, acceleration)
  const toolName = engine === 'recognition' ? 'whisper' : 'translator'
  const selected = acceleration.policy.mode === 'gpu' ? acceleration.devices.find(device => device.id === acceleration.policy.device)
    : acceleration.devices.find(device => device.backend === 'cuda' && acceleration.runtimes.cuda?.[toolName])
      ?? acceleration.devices.find(device => acceleration.runtimes[device.backend]?.[toolName]) ?? acceleration.devices[0]
  const fallback = (reason: string): LocalExecution => cpuExecution(executable, engine, acceleration, reason)
  if (!selected) return fallback(acceleration.policy.mode === 'gpu' ? '指定显卡不可用，已使用 CPU' : '未检测到可用独显，已使用 CPU')
  const runtime = acceleration.runtimes[selected.backend]
  const tool = engine === 'recognition' ? runtime?.whisper : runtime?.translator
  if (!tool) return fallback('加速运行库未就绪，已使用 CPU；可准备或修复加速运行库')
  const env: NodeJS.ProcessEnv = selected.backend === 'cuda' ? { CUDA_VISIBLE_DEVICES: selected.id, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' }
    : { GGML_VK_VISIBLE_DEVICES: String(selected.index) }
  if (runtime?.libraryDirectory) {
    const original = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    env.PATH = `${runtime.libraryDirectory}${path.delimiter}${original}`
  }
  // Independent tasks share a conservative budget; native fitting/OOM handling remains authoritative.
  const modelMiB = (await fs.stat(model)).size / 1024 ** 2
  const required = Math.ceil(modelMiB * (engine === 'recognition' ? 3 : 1.4) + 1024)
  // CUDA and Vulkan views of the same card share one budget. Identical-name multi-GPU
  // hosts conservatively share it too, rather than counting a card twice.
  const memoryKey = selected.name
  const used = reservations.get(memoryKey) ?? 0
  const available = selected.memoryMiB - 2048 - used
  const claim = engine === 'translation' ? Math.min(required, available) : required
  if (available < 2048 || claim > available) return fallback('可用显存预算不足，已使用 CPU')
  reservations.set(memoryKey, used + claim)
  let released = false
  return { executable: tool, backend: selected.backend, device: selected, env,
    args: engine === 'recognition' ? ['--device', '0']
      : ['--device', selected.backend === 'cuda' ? 'CUDA0' : 'Vulkan0', '--log-verbosity', '4', '--split-mode', 'none', '--gpu-layers', 'auto', '--fit', 'on', '--fit-target', String(2048 + used), '--fit-ctx', '8192'],
    release: () => { if (!released) { released = true; reservations.set(memoryKey, Math.max(0, (reservations.get(memoryKey) ?? 0) - claim)) } }
  }
}
export function reportLocalExecution(acceleration: LocalRuntimeAcceleration | undefined, engine: LocalEngine, execution: LocalExecution, diagnostic: string): boolean {
  const active = engine === 'translation' ? /offloaded [1-9]\d*\/\d+ layers/.test(diagnostic)
    : /whisper_backend_init_gpu: using (?:CUDA|Vulkan|Metal)\d* backend/.test(diagnostic)
  const backend = execution.backend === 'metal' ? (active ? 'metal' : 'cpu') : execution.device && !active ? 'cpu' : execution.backend
  acceleration?.status?.(engine, { backend, device: active ? execution.device?.name : undefined,
    reason: execution.device && !active ? '引擎未启用 GPU，已使用 CPU' : execution.reason })
  return !execution.device || active
}
