import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runLocalModelProcess } from '../../services/localModels/processRunner'
import type { AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { createLocalTextInference, type LocalTextInferenceOptions } from '../../services/localModels/textInference'
import { localSubtitleTranslationPrompt } from '../../services/localModels/localTranslation'
import { parseWhisperCues, SUBTITLE_CONTEXT_SECONDS, type SubtitleCue } from './subtitleDocument'

export interface SubtitleAudioStream { index: number; identity: string }
export { localModelProcessEnvironment } from '../../services/localModels/processRunner'
export function translationPrompt(japanese: string, context: string[] = []): string {
  return localSubtitleTranslationPrompt('qwen3', japanese, context)
}
export function createOfflineSubtitleInference(paths: AiRuntimePaths, workRoot: string, options: LocalTextInferenceOptions = {}) {
  const model = paths.translationModelId ?? 'qwen3'
  const translator = createLocalTextInference(paths, options)
  const threads = String(Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2))))
  return {
    translateText: translator.translateText,
    async probe(locator: string, expectedIndex: number, signal: AbortSignal): Promise<SubtitleAudioStream> {
      const value = JSON.parse(await runLocalModelProcess(paths.ffprobe, ['-v', 'error', '-show_entries',
        'stream=index,codec_type,codec_name,channels:stream_tags=language,title', '-of', 'json', locator], { signal, timeoutMs: 30000 }))
      const stream = Array.isArray(value.streams) ? value.streams.find((stream: Record<string, unknown>) => stream.index === expectedIndex && stream.codec_type === 'audio') : null
      if (!stream) throw new Error('无法匹配当前播放音轨，请重新选择音轨')
      return { index: expectedIndex, identity: JSON.stringify(stream) }
    },
    async recognize(locator: string, audioIndex: number, start: number, end: number, signal: AbortSignal): Promise<SubtitleCue[]> {
      if (!Number.isInteger(audioIndex) || audioIndex < 0 || !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end <= start || end - start > 30) throw new Error('音频识别区间无效')
      signal.throwIfAborted()
      options.log?.('识别开始', { model: 'Kotoba', audioIndex, start, end })
      await fs.mkdir(workRoot, { recursive: true })
      const directory = await fs.mkdtemp(path.join(workRoot, 'chunk-'))
      const wav = path.join(directory, 'audio.wav'), output = path.join(directory, 'recognized')
      const extractStart = Math.max(0, start - SUBTITLE_CONTEXT_SECONDS)
      try {
        await runLocalModelProcess(paths.ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(extractStart), '-i', locator,
          '-t', String(end - extractStart + SUBTITLE_CONTEXT_SECONDS), '-map', `0:${audioIndex}`, '-vn', '-sn', '-dn',
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav], { signal, timeoutMs: 45000 })
        if ((await fs.stat(wav)).size > 4 * 1024 * 1024) throw new Error('音频提取结果超限')
        await runLocalModelProcess(paths.whisper, ['-m', paths.kotoba, '-f', wav, '-l', 'ja', '-ojf', '-of', output,
          '-t', threads, '-np', '-mc', '0', '--vad', '--vad-model', paths.vad], { signal, timeoutMs: 240000 })
        if ((await fs.stat(`${output}.json`)).size > 4 * 1024 * 1024) throw new Error('日语识别结果超限')
        const raw = await fs.readFile(`${output}.json`, 'utf8')
        options.log?.('识别原始响应', { start, end, extractStart, response: raw })
        return parseWhisperCues(JSON.parse(raw), extractStart, start, end)
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    },
    async translate(cues: SubtitleCue[], signal: AbortSignal, updated: (cues: SubtitleCue[]) => Promise<void>): Promise<SubtitleCue[]> {
      if (!cues.length) return []
      await translator.ready(signal)
      const result = structuredClone(cues)
      for (let index = 0; index < result.length; index++) {
        signal.throwIfAborted()
        if (result[index].chinese) continue
        options.log?.('翻译字幕区间', { start: result[index].start, end: result[index].end })
        result[index].chinese = await translator.translateContent(localSubtitleTranslationPrompt(model, result[index].japanese,
          result.slice(Math.max(0, index - 2), index).map(cue => cue.japanese)), signal, 768)
        await updated(structuredClone(result))
      }
      return result
    },
    close: translator.close
  }
}
