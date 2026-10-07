// Isolated CLI/inference acceptance, not Electron/player or translation-quality acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createAiRuntimeInstaller } from '../apps/desktop/src/main/player/aiSubtitles/runtimeInstaller'
import { aiRuntimeAssets, currentAiRuntimeTarget } from '../apps/desktop/src/main/player/aiSubtitles/runtimeManifest'
import { createOfflineSubtitleInference } from '../apps/desktop/src/main/player/aiSubtitles/offlineInference'
import { runSubtitleProcess } from '../apps/desktop/src/main/player/aiSubtitles/processRunner'

async function main(): Promise<void> {
  const argument = (name: string, fallback: string): string => { const index = process.argv.indexOf(name); return path.resolve(index < 0 ? fallback : process.argv[index + 1]) }
  const root = argument('--runtime-root', 'out/ai-runtime-acceptance/runtime')
  const output = argument('--output', `out/ai-runtime-acceptance/${process.platform}-${process.arch}`)
  const audio = argument('--audio', 'out/ai-runtime-acceptance/sample-ja.aiff')
  await fs.mkdir(output, { recursive: true })
  const target = currentAiRuntimeTarget(), files: Record<string, string> = {
    'darwin-arm64:translator': 'llama-macos-arm64.tar.gz', 'linux-arm64:translator': 'llama-linux-arm64.tar.gz',
    'linux-arm64:whisper': 'whisper-linux-arm64.tar.gz', 'linux-arm64:ffmpeg': 'ffmpeg-linux-arm64.tar.xz'
  }
  const download: typeof fetch = async (input, init) => {
    const asset = aiRuntimeAssets(target).find(asset => asset.url === String(input))
    const cached = asset && files[`${target.platform}-${target.arch}:${asset.id}`]
    if (cached && !new Headers(init?.headers).has('range')) {
      const filename = path.resolve('out/ai-runtime-build/sources', cached)
      if (await fs.stat(filename).then(stat => stat.size === asset.bytes, () => false)) return new Response(Readable.toWeb(createReadStream(filename)) as ReadableStream<Uint8Array>)
    }
    return fetch(input, init)
  }
  const installer = createAiRuntimeInstaller(root, download, undefined, { bundleRoot: path.resolve('out/ai-runtime') })
  const report: { status: string; target: typeof target; checks: unknown[]; failure?: string } = { status: 'running', target, checks: [] }
  let inference: ReturnType<typeof createOfflineSubtitleInference> | undefined
  try {
    if (!process.argv.includes('--offline')) {
      let last = 0
      await installer.install(new AbortController().signal, (bytes, label) => {
        if (Date.now() - last > 10000) { console.log(`${label}: ${(bytes / 1e6).toFixed(1)} MB`); last = Date.now() }
      })
    }
    assert.equal(await installer.installed(), true, 'Native tools and portable weights must all be installed')
    const paths = installer.paths(), signal = new AbortController().signal
    for (const [name, filename, args] of [
      ['translator', paths.translator, ['--version']], ['ffmpeg', paths.ffmpeg, ['-version']],
      ['ffprobe', paths.ffprobe, ['-version']], ['whisper', paths.whisper, ['-h']]
    ] as const) {
      await runSubtitleProcess(filename, [...args], { signal, timeoutMs: 15000 })
      report.checks.push(`${name}-native-launch`)
    }
    if (process.argv.includes('--install-only')) { report.status = 'pass'; return }
    inference = createOfflineSubtitleInference(paths, path.join(output, 'work'), { request: async (input, init) => {
      assert.equal(new URL(String(input)).hostname, '127.0.0.1', 'No external inference requests')
      return fetch(input, init)
    } })
    const translated = await inference.translateText('今日は天気がいいです。図書館に行きます。', signal)
    assert.match(translated, /天气|图书馆/)
    report.checks.push({ name: 'offline-text-translation', translated })
    assert.equal((await inference.probe(audio, 0, signal)).index, 0)
    const cues = await inference.recognize(audio, 0, 0, 20, signal)
    assert.ok(cues.length > 0 && cues.some(cue => /今日|天気|図書館|字幕/.test(cue.japanese)), 'Actual Japanese speech must be recognized')
    const bilingual = await inference.translate(cues, signal, async () => {})
    assert.ok(bilingual.every(cue => typeof cue.chinese === 'string' && cue.chinese.length > 0))
    report.checks.push({ name: 'audio-probe-extraction-recognition-and-translation', bilingual })
    assert.deepEqual(await fs.readdir(path.join(output, 'work')), [], 'Temporary chunks cleaned')
    report.status = 'pass'
  } catch (error) { report.status = 'failed'; report.failure = String(error); throw error }
  finally {
    await inference?.close()
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
