import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LocalExecutionStatus, LocalModelId } from '@shared/desktop/localModels'
import type { AiRuntimePaths } from './runtimeInstaller'
import { createLocalTextInference } from './textInference'
import { cpuExecution, reportLocalExecution, selectLocalExecution } from './runtimeAcceleration'
import { LocalModelProcessFailure, runLocalModelProcess } from './processRunner'

/** A synthetic, local-only probe exercises the configured model without a user task. */
export async function validateModelRuntime(paths: AiRuntimePaths, model: LocalModelId, signal: AbortSignal): Promise<LocalExecutionStatus> {
  let result: LocalExecutionStatus = { backend: 'idle' }
  const probe = { ...paths, acceleration: paths.acceleration && { ...paths.acceleration,
    status: (_kind: unknown, value: LocalExecutionStatus) => { result = value } } }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120000)])
  bounded.throwIfAborted()
  if (model !== 'kotoba') {
    const inference = createLocalTextInference(probe)
    try { await inference.translateText('こんにちは。', bounded); return result }
    finally { await inference.close() }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-check-'))
  try {
    // 0.5 s of quiet synthetic tone, no microphone, film audio or external fixture.
    const samples = 8000, wav = Buffer.alloc(44 + samples * 2)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
    for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(200 * Math.sin(index * Math.PI / 40)), 44 + index * 2)
    const input = path.join(directory, 'probe.wav'), output = path.join(directory, 'probe')
    await fs.writeFile(input, wav)
    // No VAD: the short probe must actually execute the encoder/decoder.
    const args = ['-m', paths.kotoba, '-f', input, '-l', 'ja', '-t', '2', '-mc', '0', '-ojf', '-of', output]
    const execution = await selectLocalExecution(paths.whisper, paths.kotoba, 'recognition', probe.acceleration)
    let retry = false, diagnostic = ''
    try {
      await runLocalModelProcess(execution.executable, [...args, ...execution.args], { signal: bounded, timeoutMs: 120000,
        runtimeEnv: execution.env, diagnostic: value => { diagnostic = value } })
      retry = !reportLocalExecution(probe.acceleration, 'recognition', execution, diagnostic)
    } catch (cause) {
      if (bounded.aborted || !execution.device || !(cause instanceof LocalModelProcessFailure) || !cause.gpuFailure) throw cause
      retry = true
    } finally { execution.release() }
    if (retry) {
      bounded.throwIfAborted()
      const cpu = cpuExecution(paths.whisper, 'recognition', probe.acceleration, '显卡试运行失败，CPU 试运行通过；可修复加速后重新验证')
      await runLocalModelProcess(cpu.executable, [...args, ...cpu.args], { signal: bounded, timeoutMs: 120000 })
    }
    JSON.parse(await fs.readFile(`${output}.json`, 'utf8'))
    return result
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
