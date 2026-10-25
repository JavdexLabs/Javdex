import fs from 'node:fs/promises'
import os from 'node:os'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { LocalModelProcessFailure, runLocalModelProcess } from '../../services/localModels/processRunner'
import { reserveLocalGpuMemory } from '../../services/localModels/runtimeAcceleration'
import type { LocalExecutionStatus } from '@shared/desktop/localModels'
import { parseAudioCppVulkanDevices } from '../../services/localModels/audioCppDevices'
export { parseAudioCppVulkanDevices } from '../../services/localModels/audioCppDevices'
import type { SubtitleCue } from './subtitleDocument'

async function readQwenResult(file: string): Promise<string> {
  if ((await fs.stat(file)).size > 4 * 1024 ** 2) throw new Error('Qwen 识别结果超限')
  return fs.readFile(file, 'utf8')
}

/** audio.cpp --words-out uses sample offsets at the 16 kHz input rate, not milliseconds. */
export function parseQwenCues(value: unknown, transcript: string, extractStart: number, start: number, end: number): SubtitleCue[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Qwen 识别结果缺少有效时间戳')
  // audio.cpp legitimately skips alignment when the transcript contains only punctuation/symbols.
  if (!value.length && /[\p{L}\p{N}]/u.test(transcript)) throw new Error('Qwen 识别文本未获得对齐时间戳')
  const words: Array<{ start: number; end: number; text: string }> = []
  let cursor = 0, previousStart = -1
  const content = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '')
  let alignedText = ''
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.word !== 'string'
      || !Number.isSafeInteger(item.start_sample) || !Number.isSafeInteger(item.end_sample)
      || item.start_sample < 0 || item.end_sample < item.start_sample || item.start_sample < previousStart
      || item.end_sample / 16000 > end - extractStart + 3.1) throw new Error('Qwen 对齐时间戳无效')
    previousStart = item.start_sample
    let text = item.word.replace(/[\u0000-\u001f]/g, '').trim()
    if (!text) continue
    if (text.length > 1800 || item.end_sample === item.start_sample && /[\p{L}\p{N}]/u.test(text)) throw new Error('Qwen 对齐文字缺少有效时长')
    alignedText += text
    const at = transcript.indexOf(text, cursor)
    if (at >= cursor) {
      cursor = at + text.length
      const punctuation = transcript.slice(cursor).match(/^[\p{P}\s]*/u)?.[0] ?? ''
      text += punctuation; cursor += punctuation.length
    }
    const from = extractStart + item.start_sample / 16000, to = extractStart + item.end_sample / 16000
    if ((from + to) / 2 >= start && (from + to) / 2 < end) words.push({ start: from, end: to, text })
  }
  if (content(transcript) && content(alignedText) !== content(transcript)) throw new Error('Qwen 对齐结果未完整覆盖识别文字，请重试')
  const cues: SubtitleCue[] = []
  for (const word of words) {
    const previous = cues.at(-1)
    if (previous && word.start - previous.end < 0.6 && word.end - previous.start <= 7
      && previous.japanese.length + word.text.length <= 44 && !/[。！？!?][」』”"]?\s*$/.test(previous.japanese)) {
      previous.end = Math.max(previous.end, word.end); previous.japanese += word.text
    } else cues.push({ start: word.start, end: word.end, japanese: word.text })
  }
  return cues
}

export function createQwenAsrRecognition(paths: AiRuntimePaths, run = runLocalModelProcess) {
  let cpuReason: string | undefined
  return async (wav: string, output: string, extractStart: number, start: number, end: number, signal: AbortSignal,
    log?: (stage: string, value: unknown) => void, forcedText?: string): Promise<SubtitleCue[]> => {
    signal.throwIfAborted()
    const model = paths.qwenAsr
    if (!model) throw new Error('Qwen3-ASR 运行库未就绪，请在本地模型页下载或修复')
    const align = !!forcedText || model.forcedAligner !== false
    const policy = paths.acceleration?.policy ?? { mode: 'cpu' }
    let execution: LocalExecutionStatus = { backend: 'cpu', reason: cpuReason }
    let executable = model.executable, device = 0, release: (() => void) | null = null
    const gpuTool = paths.acceleration?.runtimes.vulkan?.audiocpp
    if (!cpuReason && policy.mode !== 'cpu' && gpuTool) {
      try {
        let diagnostic = ''
        const output = await run(gpuTool, ['--list-devices'], { signal, timeoutMs: 15000, diagnostic: text => { diagnostic = text } })
        const devices = parseAudioCppVulkanDevices(output, diagnostic)
        const selected = policy.mode === 'gpu' ? paths.acceleration?.devices.find(item => item.id === policy.device) : undefined
        const gpu = policy.mode === 'gpu'
          ? devices.filter(item => item.name === selected?.name).length === 1 ? devices.find(item => item.name === selected?.name) : undefined
          : devices.find(item => !item.integrated) ?? devices[0]
        if (gpu) {
          const inventory = paths.acceleration?.devices.find(item => item.name === gpu.name)
          const capacity = gpu.integrated ? Math.min(inventory?.memoryMiB ?? Infinity, os.freemem() / 1024 ** 2 / 2) : inventory?.memoryMiB
          const bytes = (await fs.stat(model.model)).size + (align ? (await fs.stat(model.aligner)).size : 0)
          // Enumeration can be available before the shared device inventory is refreshed.
          if (capacity) release = reserveLocalGpuMemory(gpu.name, capacity, Math.ceil(bytes / 1024 ** 2 * 1.5 + 1024))
          if (release) { executable = gpuTool; device = gpu.index; execution = { backend: 'vulkan', device: gpu.name } }
          else execution.reason = '可用显存预算不足或设备信息未就绪，已使用 CPU'
        } else execution.reason = '指定显卡不可用或未检测到可用硬件显卡，已使用 CPU'
      } catch (cause) { if (signal.aborted) throw cause; execution.reason = '显卡检测失败，已使用 CPU' }
    } else if (policy.mode !== 'cpu' && !cpuReason) execution.reason = 'Qwen GPU 运行库未就绪，已使用 CPU'
    const args = ['--task', forcedText ? 'align' : 'asr', '--family', forcedText ? 'qwen3_forced_aligner' : 'qwen3_asr',
      '--model', forcedText ? model.aligner : model.model, '--audio', wav, '--language', 'Japanese',
      '--audio-chunk-mode', 'none', '--text', forcedText ?? '', ...(align ? ['--words-out', `${output}.json`] : []),
      '--threads', String(Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2)))), '--max-tokens', '1024',
      '--request-option', 'clamp_timestamps_to_audio=true', '--metrics',
      ...(!forcedText ? ['--text-out', `${output}.txt`, '--request-option', 'preserve_punctuation=true',
        ...(align ? ['--session-option', `qwen3_asr.forced_aligner_path=${model.aligner}`] : [])] : [])]
    const began = performance.now()
    try {
      try {
        await run(executable, [...args, '--backend', execution.backend, '--device', String(device)], { signal, timeoutMs: 240000,
          diagnostic: text => log?.('Qwen 运行诊断', text), output: text => log?.('Qwen 标准输出', text) })
      } catch (cause) {
        if (signal.aborted || execution.backend === 'cpu' || !(cause instanceof LocalModelProcessFailure) || !cause.gpuFailure) throw cause
        release?.(); release = null
        await Promise.all(['json', 'txt'].map(ext => fs.rm(`${output}.${ext}`, { force: true })))
        cpuReason = 'Qwen GPU 推理失败，已使用相同权重回退 CPU'
        execution = { backend: 'cpu', reason: cpuReason }
        await run(model.executable, [...args, '--backend', 'cpu'], { signal, timeoutMs: 240000,
          diagnostic: text => log?.('Qwen CPU 运行诊断', text), output: text => log?.('Qwen CPU 标准输出', text) })
      }
      signal.throwIfAborted()
      paths.acceleration?.status?.('recognition', execution)
      const transcript = forcedText ?? await readQwenResult(`${output}.txt`)
      let words: unknown
      if (align) {
        try { words = JSON.parse(await readQwenResult(`${output}.json`)) }
        catch (cause) {
          // audio.cpp omits --words-out entirely when there is no alignable transcript.
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || /[\p{L}\p{N}]/u.test(transcript)) throw cause
          words = []
        }
      }
      log?.('Qwen 原始识别结果', { transcript, words, forcedAligner: align })
      const text = transcript.replace(/[\u0000-\u001f]/g, '').trim()
      if (text.length > 18000) throw new Error('Qwen 识别文本超限')
      // Without alignment, only the requested audio interval is known. Do not invent word timestamps.
      const cues = align ? parseQwenCues(words, transcript, extractStart, start, end)
        : text ? [{ start, end, japanese: text }] : []
      const milliseconds = Math.round(performance.now() - began)
      log?.(align ? 'Qwen 识别与对齐完成' : 'Qwen 识别完成（未对齐）', { model: 'Qwen3-ASR-1.7B Q8_0', forcedAligner: align, milliseconds, audioSeconds: end - extractStart + (align ? 3 : 0),
        backend: execution.backend, transcript, words, cues })
      return cues
    } finally { release?.() }
  }
}
