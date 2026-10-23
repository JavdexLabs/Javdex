// Model-store UI acceptance only: no real model downloads, inference or license-gate acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAcceptanceDirectory, launchAcceptance, closeAcceptance, recordAcceptanceCleanup } from './playback-acceptance-support.mjs'
import { waitForLocalModelSettings, checkLocalModelCatalog, checkLocalModelInstalledFilters } from './local-model-settings-ui.mjs'

const outputRoot = path.resolve('out/playback-acceptance/model-store')
await fs.mkdir(outputRoot, { recursive: true })
const output = await fs.mkdtemp(path.join(outputRoot, 'run-'))
const directory = await fs.realpath(createAcceptanceDirectory('model-store-'))
const report = { status: 'running', checks: [] }
let application
try {
  application = await launchAcceptance(directory, 'model-store-application.log')
  const page = await application.firstWindow(), rendererErrors = []
  page.on('pageerror', cause => rendererErrors.push(cause.message))
  await page.waitForFunction(() => window.api?.settings)
  await page.evaluate(() => { window.location.hash = '/settings/models/local' })
  await waitForLocalModelSettings(page)
  const snapshot = () => page.evaluate(() => window.api.settings.getLocalModels())
  const initial = await snapshot()
  assert.deepEqual(initial.environments.map(environment => environment.group), ['speech', 'speech2', 'text'])
  const speech2 = page.getByRole('region', { name: '语音模型2', exact: true })
  assert.equal(await speech2.getByRole('article', { name: 'Qwen3-ASR 1.7B 模型文件', exact: true }).count(), 1)
  assert.equal(await speech2.getByRole('article', { name: 'Kotoba Whisper 模型文件', exact: true }).count(), 0)
  assert.ok(initial.environments.find(environment => environment.group === 'speech').components.every(component => !/audiocpp|qwen-aligner/.test(component.id)))
  assert.ok(initial.environments.find(environment => environment.group === 'speech2').components.every(component => !/whisper|vad/.test(component.id)))
  report.checks.push('independent-speech-and-temporary-speech2-environments')
  const aligner = speech2.getByRole('switch', { name: 'ForcedAligner 时间轴对齐', exact: true })
  assert.equal(await aligner.isChecked(), true)
  await aligner.uncheck()
  await page.waitForFunction(() => window.api.settings.getLocalModels().then(value => value.qwenForcedAligner === false && !value.operation))
  assert.equal((await snapshot()).environments.find(item => item.group === 'speech2').preparation.items.some(item => item.id === 'qwen-aligner-common'), false)
  assert.deepEqual((await snapshot()).usage, initial.usage)
  await aligner.check()
  await page.waitForFunction(() => window.api.settings.getLocalModels().then(value => value.qwenForcedAligner === true && !value.operation))
  assert.equal((await snapshot()).environments.find(item => item.group === 'speech2').preparation.items.some(item => item.id === 'qwen-aligner-common'), true)
  report.checks.push('forced-aligner-switch-roundtrip-updates-dependencies-without-downloads-or-usage-changes')
  assert.deepEqual(initial.models.map(model => [model.id, model.variants.length]), [['qwen3', 4], ['kotoba', 2], ['hy-mt2-7b', 3], ['qwen3-asr', 1]])
  assert.deepEqual(initial.models.find(model => model.id === 'qwen3').variants.map(variant => variant.id), [
    'qwen3-q4_k_m', 'qwen3-q5_k_m', 'qwen3-q6_k', 'qwen3-official-q8_0'
  ])
  assert.equal(initial.directory, path.join(directory, 'local-ai'))
  assert.equal(initial.defaultDirectory, initial.directory)
  assert.equal(initial.translationModel, 'hy-mt2-7b')
  assert.equal(initial.usage.textTranslation.mode, 'local')
  assert.equal(initial.usage.textTranslation.model, 'hy-mt2-7b')
  report.checks.push('independent-model-directory-and-four-model-families')
  await checkLocalModelCatalog(page, initial.models)
  assert.deepEqual((await snapshot()).usage, initial.usage)
  report.checks.push('ten-precisions-and-provenance-without-mutating-usage')
  await checkLocalModelInstalledFilters(page)
  report.checks.push('installed-only-empty-states-by-modality')
  await page.evaluate(() => { window.location.hash = '/settings/models/usage' })
  const binding = page.getByRole('button', { name: '语音识别模型', exact: true })
  await binding.click()
  await page.getByRole('option', { name: 'Qwen3-ASR 1.7B', exact: true }).click()
  const subtitles = page.locator('#ai-subtitles')
  await subtitles.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.api.settings.getLocalModels().then(value => value.usage.subtitleRecognition.model === 'qwen3-asr' && !value.operation))
  assert.deepEqual((await snapshot()).usage.subtitleTranslation, initial.usage.subtitleTranslation)
  await subtitles.getByRole('group', { name: '语音识别', exact: true }).getByRole('button', { name: '前往下载', exact: true }).click()
  await page.getByRole('article', { name: 'Qwen3-ASR 1.7B 模型文件', exact: true }).waitFor()
  assert.ok((await snapshot()).models.find(model => model.id === 'qwen3-asr').variants[0].dependencies.missing.some(name => name.includes('ForcedAligner')))
  await page.evaluate(() => { window.location.hash = '/settings/models/usage' })
  await binding.click()
  await page.getByRole('option', { name: 'Kotoba Whisper', exact: true }).click()
  await subtitles.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.api.settings.getLocalModels().then(value => value.usage.subtitleRecognition.model === 'kotoba' && !value.operation))
  assert.deepEqual((await snapshot()).usage, initial.usage)
  report.checks.push('qwen-asr-choice-provenance-navigation-and-kotoba-restoration-without-downloads')
  await page.evaluate(() => { window.location.hash = '/settings/models/local' })
  await waitForLocalModelSettings(page)
  const storage = page.locator('[aria-label="存储与维护"]')
  assert.equal(await storage.getByText(initial.directory, { exact: true }).isVisible(), true)
  const partial = path.join(initial.directory, 'downloads', 'a'.repeat(64)), cache = path.join(directory, 'cache', 'ai-subtitles')
  const weight = path.join(initial.directory, 'models', 'preserved-test-file')
  await fs.mkdir(partial, { recursive: true }); await fs.writeFile(path.join(partial, 'weight.part'), 'resume')
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, 'cache-test'), 'cached')
  await fs.mkdir(path.dirname(weight), { recursive: true }); await fs.writeFile(weight, 'keep')
  await page.getByRole('button', { name: '刷新统计', exact: true }).click()
  await page.waitForFunction(() => window.api.settings.getLocalModels().then(value => value.storage?.downloads.files > 0 && value.storage?.cache.files > 0))
  await page.getByRole('button', { name: '清理未完成下载', exact: true }).click()
  await page.getByText('未完成下载已清理', { exact: true }).waitFor()
  await assert.rejects(fs.access(partial)); await fs.access(path.join(cache, 'cache-test'))
  await page.getByRole('button', { name: '清理推理缓存', exact: true }).click()
  await page.getByText('推理缓存已清理', { exact: true }).waitFor()
  await assert.rejects(fs.access(cache)); assert.equal(await fs.readFile(weight, 'utf8'), 'keep')
  report.checks.push('cleanup-buttons-through-product-ipc-preserve-model-files')
  for (const [name, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 640 }]]) {
    await page.setViewportSize(size)
    await page.getByRole('heading', { name: '语音模型', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    for (const family of await page.getByRole('article').all()) {
      assert.equal(await family.evaluate(node => node.scrollWidth > node.clientWidth), false)
    }
    await page.screenshot({ path: path.join(output, `model-store-${name}.png`) })
    await speech2.evaluate(node => node.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(output, `model-store-speech2-${name}.png`) })
    await page.getByRole('article', { name: 'Qwen3 1.7B 模型文件' }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(output, `model-store-qwen-${name}.png`) })
    report.checks.push(`${name}-layout-no-horizontal-overflow`)
  }
  assert.deepEqual(rendererErrors, [])
  report.status = 'pass'
} catch (cause) { report.status = 'failed'; report.failure = cause.stack ?? String(cause); throw cause }
finally {
  if (application) recordAcceptanceCleanup(report, await closeAcceptance(application))
  if (!application || (report.cleanup && !report.cleanup.forced && report.cleanup.code === 0)) {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('javdex-playback-acceptance-model-store-'))
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
    await fs.rm(directory, { recursive: true, force: true })
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, report: path.join(output, 'report.json') }))
}
