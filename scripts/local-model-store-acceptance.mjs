// Model-store UI acceptance only: no real model downloads, inference or license-gate acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAcceptanceDirectory, launchAcceptance, closeAcceptance, recordAcceptanceCleanup } from './playback-acceptance-support.mjs'

const output = path.resolve('out/playback-acceptance/model-store')
await fs.mkdir(output, { recursive: true })
const directory = createAcceptanceDirectory('model-store-')
const report = { status: 'running', checks: [] }
let application
try {
  application = await launchAcceptance(directory, 'model-store-application.log')
  const page = await application.firstWindow(), rendererErrors = []
  page.on('pageerror', cause => rendererErrors.push(cause.message))
  await page.waitForFunction(() => window.api?.settings)
  await page.evaluate(() => { window.location.hash = '/settings/models/local' })
  await page.getByRole('heading', { name: '模型文件', exact: true }).waitFor()
  const snapshot = () => page.evaluate(() => window.api.settings.getLocalModels())
  const initial = await snapshot()
  assert.deepEqual(initial.models.map(model => [model.id, model.variants.length]), [['qwen3', 4], ['kotoba', 2], ['hy-mt2-7b', 3]])
  assert.deepEqual(initial.models.find(model => model.id === 'qwen3').variants.map(variant => variant.id), [
    'qwen3-q4_k_m', 'qwen3-q5_k_m', 'qwen3-q6_k', 'qwen3-official-q8_0'
  ])
  assert.equal(initial.directory, path.join(directory, 'local-ai'))
  assert.equal(initial.defaultDirectory, initial.directory)
  assert.equal(initial.translationModel, 'qwen3')
  assert.equal(await page.getByRole('article').count(), 3)
  report.checks.push('independent-model-directory-and-three-model-families')
  for (const model of initial.models) {
    const family = page.getByRole('article', { name: `${model.name} 模型文件` })
    await family.getByRole('button', { name: `${model.name} 管理精度` }).click()
    await family.getByRole('button', { name: `${model.name} 精度范围` }).click()
    await page.getByRole('option', { name: '全部精度', exact: true }).click()
    assert.equal(await family.locator('[role="row"][data-variant]').count(), model.variants.length)
    await family.locator('summary').click()
    for (const source of new Set(model.variants.map(variant => variant.source))) {
      assert.equal(await family.getByText(source, { exact: true }).isVisible(), true)
    }
    await family.locator('summary').click()
  }
  assert.deepEqual((await snapshot()).usage, initial.usage)
  report.checks.push('nine-precisions-and-provenance-without-mutating-usage')
  await page.getByRole('button', { name: '模型文件范围' }).click()
  await page.getByRole('option', { name: '已安装模型', exact: true }).click()
  assert.equal(await page.getByRole('article').count(), 0)
  assert.equal(await page.getByText('尚未下载此模态的模型精度，可切换到“全部模型”后下载或导入。', { exact: true }).count(), 2)
  await page.getByRole('button', { name: '模型文件范围' }).click()
  await page.getByRole('option', { name: '全部模型', exact: true }).click()
  report.checks.push('installed-only-empty-states-by-modality')
  await page.getByText('下载、保存位置与运行环境', { exact: true }).click()
  assert.equal(await page.getByText(`保存位置：${initial.directory}`, { exact: true }).isVisible(), true)
  const partial = path.join(initial.directory, 'downloads', 'a'.repeat(64)), cache = path.join(directory, 'cache', 'ai-subtitles')
  const weight = path.join(initial.directory, 'models', 'preserved-test-file')
  await fs.mkdir(partial, { recursive: true }); await fs.writeFile(path.join(partial, 'weight.part'), 'resume')
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, 'cache-test'), 'cached')
  await fs.mkdir(path.dirname(weight), { recursive: true }); await fs.writeFile(weight, 'keep')
  await page.getByRole('button', { name: '清理未完成下载', exact: true }).click()
  await page.getByText('未完成下载已清理', { exact: true }).waitFor()
  await assert.rejects(fs.access(partial)); await fs.access(path.join(cache, 'cache-test'))
  await page.getByRole('button', { name: '清理推理缓存', exact: true }).click()
  await page.getByText('推理缓存已清理', { exact: true }).waitFor()
  await assert.rejects(fs.access(cache)); assert.equal(await fs.readFile(weight, 'utf8'), 'keep')
  report.checks.push('cleanup-buttons-through-product-ipc-preserve-model-files')
  for (const [name, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 640 }]]) {
    await page.setViewportSize(size)
    await page.getByRole('heading', { name: '模型文件', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    for (const family of await page.getByRole('article').all()) {
      assert.equal(await family.evaluate(node => node.scrollWidth > node.clientWidth), false)
    }
    await page.screenshot({ path: path.join(output, `model-store-${name}.png`) })
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
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('javdex-playback-acceptance-model-store-'))
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
    await fs.rm(directory, { recursive: true, force: true })
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, report: path.join(output, 'report.json') }))
}
