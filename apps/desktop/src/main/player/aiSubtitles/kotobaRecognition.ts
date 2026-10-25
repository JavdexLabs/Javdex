import fs from 'node:fs/promises'
import os from 'node:os'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { gpuMemoryFailure, LocalModelProcessFailure, runLocalModelProcess } from '../../services/localModels/processRunner'
import { cpuExecution, executionUsesGpu, reportLocalExecution, selectLocalExecution } from '../../services/localModels/runtimeAcceleration'
import { parseWhisperCues, type SubtitleCue } from './subtitleDocument'

export function createKotobaRecognition(paths: AiRuntimePaths, run = runLocalModelProcess, nativeDiagnostic?: (text: string) => void) {
  const threads = String(Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2))))
  let recognitionCpuReason: string | undefined
  return async (wav: string, output: string, extractStart: number, start: number, end: number, signal: AbortSignal,
    log?: (stage: string, value: unknown) => void): Promise<SubtitleCue[]> => {
    const args = ['-m', paths.kotoba, '-f', wav, '-l', 'ja', '-ojf', '-of', output,
      '-t', threads, '-mc', '0', '--vad', '--vad-model', paths.vad]
    const execution = recognitionCpuReason ? cpuExecution(paths.whisper, 'recognition', paths.acceleration, recognitionCpuReason)
      : await selectLocalExecution(paths.whisper, paths.kotoba, 'recognition', paths.acceleration)
    let retry = false, diagnostic = ''
    try {
      await run(execution.executable, [...args, ...execution.args], { signal, timeoutMs: 240000,
        runtimeEnv: execution.env, diagnostic: value => { diagnostic = value } })
      nativeDiagnostic?.(diagnostic)
      retry = !reportLocalExecution(paths.acceleration, 'recognition', execution, diagnostic)
    } catch (cause) {
      if (signal.aborted || !executionUsesGpu(execution) || !(cause instanceof LocalModelProcessFailure) || !cause.gpuFailure) throw cause
      retry = true
    } finally { execution.release() }
    if (retry) {
      signal.throwIfAborted()
      recognitionCpuReason = gpuMemoryFailure(diagnostic) ? 'GPU 显存分配失败，已自动回退 CPU' : 'GPU 未启用或运行失败，已自动回退 CPU'
      const cpu = cpuExecution(paths.whisper, 'recognition', paths.acceleration, recognitionCpuReason)
      await run(cpu.executable, [...args, ...cpu.args], { signal, timeoutMs: 240000 })
    }
    if ((await fs.stat(`${output}.json`)).size > 4 * 1024 * 1024) throw new Error('日语识别结果超限')
    const raw = await fs.readFile(`${output}.json`, 'utf8')
    log?.('识别原始响应', { start, end, extractStart, response: raw })
    return parseWhisperCues(JSON.parse(raw), extractStart, start, end)
  }
}
