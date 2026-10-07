// Isolated Windows settings acceptance with real Qwen inference and filesystem operations.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { AI_SUBTITLE_RUNTIME_VERSION, AI_SUBTITLE_ASSETS } from '../apps/desktop/src/main/player/aiSubtitles/runtimeManifest.ts'
import { createAcceptanceDirectory, launchAcceptance, closeAcceptance, recordAcceptanceCleanup } from './playback-acceptance-support.mjs'

const output = path.resolve('out/playback-acceptance/local-models')
await fs.mkdir(output, { recursive: true })
const directory = createAcceptanceDirectory('local-models-')
const models = path.join(directory, 'ai-subtitles/models', AI_SUBTITLE_RUNTIME_VERSION)
await fs.cp(path.resolve('.tmp-ai-subtitle/runtime', AI_SUBTITLE_RUNTIME_VERSION), models, { recursive: true })
const moved = path.join(directory, 'relocated-models'), exported = path.join(directory, 'exported')
await fs.mkdir(exported, { recursive: true })
const report = { status: 'running', checks: [] }
let application
try {
  application = await launchAcceptance(directory, 'local-model-application.log')
  const page = await application.firstWindow()
  const rendererErrors = []
  page.on('pageerror', cause => rendererErrors.push(cause.message))
  await page.waitForFunction(() => window.api?.settings)
  await page.evaluate(() => { window.location.hash = '/settings/models/local' })
  await page.getByRole('heading', { name: '保存位置', exact: true }).waitFor()
  const command = command => page.evaluate(command => window.api.settings.localModelCommand(command), command)
  const snapshot = () => page.evaluate(() => window.api.settings.getLocalModels())
  assert.ok((await snapshot()).models.every(model => model.installed))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: path.join(output, 'settings-wide.png') })
  await page.setViewportSize({ width: 1000, height: 640 })
  await page.screenshot({ path: path.join(output, 'settings-narrow.png') })
  await command({ action: 'translation', mode: 'local' })
  // Reject outside fetches to demonstrate that the existing AI translation IPC uses local inference.
  await application.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname !== '127.0.0.1') throw new Error('external fetch blocked by local model acceptance')
      return original(input, init)
    }
  })
  const started = Date.now()
  const chinese = await page.evaluate(() => window.api.llm.translateToChinese('今日は天気がいいです。図書館に行きます。'))
  assert.match(chinese, /天气|图书馆/)
  report.checks.push({ name: 'existing-ai-translation-ipc-offline', chinese, elapsedMs: Date.now() - started })
  // Override only native file-selection dialogs in this isolated host; commands remain product IPC.
  await application.evaluate(({ dialog }, moved) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [moved] })
  }, moved)
  await command({ action: 'choose-location' })
  assert.equal((await snapshot()).directory, moved)
  assert.equal(await fs.access(models).then(() => true, () => false), false)
  const afterMove = await page.evaluate(() => window.api.llm.translateToChinese('字幕を表示してください。'))
  assert.match(afterMove, /字幕/)
  report.checks.push({ name: 'relocation-and-real-translation', afterMove })
  await application.evaluate(({ dialog }, exported) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exported] })
  }, exported)
  await command({ action: 'export', model: 'qwen3' })
  const hash = createHash('sha256')
  const exportedFile = path.join(exported, 'Qwen3-1.7B-Q4/qwen3-q4.gguf')
  for await (const chunk of createReadStream(exportedFile)) hash.update(chunk)
  assert.equal(hash.digest('hex'), AI_SUBTITLE_ASSETS.find(asset => asset.id === 'translation-model').sha256)
  assert.ok((await fs.readFile(path.join(exported, 'Qwen3-1.7B-Q4/LICENSE.txt'), 'utf8')).includes('Apache License'))
  report.checks.push({ name: 'export-exact-model-and-license' })
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await command({ action: 'delete', model: 'qwen3' })
  assert.equal((await snapshot()).models.find(model => model.id === 'qwen3').installed, false)
  assert.equal((await snapshot()).translation, 'local')
  await assert.rejects(page.evaluate(() => window.api.llm.translateToChinese('こんにちは')), /未安装/)
  assert.equal((await snapshot()).models.find(model => model.id === 'kotoba').installed, true)
  report.checks.push({ name: 'delete-isolated-and-no-online-fallback' })
  await command({ action: 'reset-location' })
  assert.equal((await snapshot()).directory, (await snapshot()).defaultDirectory)
  assert.deepEqual(rendererErrors, [])
  report.status = 'pass'
} catch (cause) { report.status = 'failed'; report.failure = cause.stack ?? String(cause); throw cause }
finally {
  if (application) recordAcceptanceCleanup(report, await closeAcceptance(application))
  if (!application || (report.cleanup && !report.cleanup.forced && report.cleanup.code === 0)) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('javdex-playback-acceptance-local-models-'))
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
    await fs.rm(directory, { recursive: true, force: true })
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, report: path.join(output, 'report.json') }))
}
await delay(50)
