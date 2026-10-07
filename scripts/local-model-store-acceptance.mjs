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
  await page.getByRole('heading', { name: '模型商店', exact: true }).waitFor()
  const snapshot = () => page.evaluate(() => window.api.settings.getLocalModels())
  const initial = await snapshot()
  const qwen = page.getByRole('article', { name: 'Qwen3 1.7B 模型精度' })
  const kotoba = page.getByRole('article', { name: 'Kotoba Whisper 模型精度' })
  const hy = page.getByRole('article', { name: 'HY-MT2 7B 模型精度' })
  const index = page.getByRole('article', { name: 'Index-Translate 9B 模型精度' })
  assert.deepEqual(initial.models.map(model => model.variants.length), [25, 2, 3, 12])
  assert.equal(initial.translationModel, 'qwen3')
  await page.getByRole('button', { name: 'Qwen3 1.7B 查看精度' }).click()
  assert.equal(await page.getByRole('option').count(), 25)
  await page.getByRole('option', { name: /^Q8_0 · Qwen ·/ }).click()
  assert.equal((await snapshot()).models[0].selectedVariant, initial.models[0].selectedVariant)
  assert.equal(await qwen.getByRole('button', { name: '使用此精度', exact: true }).isDisabled(), true)
  await assert.rejects(page.evaluate(() => window.api.settings.localModelCommand({
    action: 'select', model: 'qwen3', variant: 'qwen3-official-q8_0'
  })), /先下载/)
  assert.equal((await snapshot()).models[0].selectedVariant, initial.models[0].selectedVariant)
  report.checks.push('25-qwen-precisions-and-explicit-selection')
  await page.getByRole('button', { name: 'Kotoba Whisper 查看精度' }).click()
  assert.equal(await page.getByRole('option').count(), 2)
  await page.getByRole('option', { name: /^F16 ·/ }).click()
  assert.equal((await snapshot()).models[1].selectedVariant, initial.models[1].selectedVariant)
  report.checks.push('2-kotoba-ggml-precisions-not-mislabeled-as-2.2')
  await page.getByRole('button', { name: 'HY-MT2 7B 查看精度' }).click()
  assert.equal(await page.getByRole('option').count(), 3)
  await page.getByRole('option', { name: /^Q6_K · tencent ·/ }).click()
  assert.equal((await snapshot()).models.find(model => model.id === 'hy-mt2-7b').selectedVariant, 'hy-mt2-7b-q4_k_m')
  assert.equal((await snapshot()).translationModel, 'qwen3')
  assert.equal(await hy.getByRole('button', { name: '使用此精度', exact: true }).isDisabled(), true)
  await assert.rejects(page.evaluate(() => window.api.settings.localModelCommand({
    action: 'translation-model', model: 'hy-mt2-7b'
  })), /先下载/)
  assert.equal((await snapshot()).translationModel, 'qwen3')
  await page.getByRole('button', { name: '本地翻译模型', exact: true }).click()
  assert.equal(await page.getByRole('option', { name: /^HY-MT2 7B/ }).isDisabled(), true)
  await page.keyboard.press('Escape')
  report.checks.push('3-official-hy-7b-precisions-and-explicit-family-selection')
  await page.getByRole('button', { name: 'Index-Translate 9B 查看精度' }).click()
  assert.equal(await page.getByRole('option').count(), 12)
  await page.getByRole('option', { name: /^F16 · IndexTeam ·/ }).click()
  assert.equal((await snapshot()).models.find(model => model.id === 'index-translate-9b').selectedVariant, 'index-translate-9b-q4_k_m')
  assert.equal((await snapshot()).translationModel, 'qwen3')
  assert.equal(await index.getByRole('button', { name: '使用此精度', exact: true }).isDisabled(), true)
  await assert.rejects(page.evaluate(() => window.api.settings.localModelCommand({
    action: 'select', model: 'index-translate-9b', variant: 'index-translate-9b-f16'
  })), /先下载/)
  await assert.rejects(page.evaluate(() => window.api.settings.localModelCommand({
    action: 'translation-model', model: 'index-translate-9b'
  })), /先下载/)
  assert.equal((await snapshot()).translationModel, 'qwen3')
  await page.getByRole('button', { name: '本地翻译模型', exact: true }).click()
  assert.equal(await page.getByRole('option', { name: /^Index-Translate 9B/ }).isDisabled(), true)
  await page.keyboard.press('Escape')
  report.checks.push('12-official-index-9b-text-precisions-and-explicit-family-selection')
  await page.getByRole('button', { name: '模型商店范围' }).click()
  await page.getByRole('option', { name: '已下载精度', exact: true }).click()
  await page.getByText('尚未下载模型精度，请切换到“全部精度”下载。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('article').count(), 0)
  await page.getByRole('button', { name: '模型商店范围' }).click()
  await page.getByRole('option', { name: '全部精度', exact: true }).click()
  report.checks.push('installed-only-empty-state-and-return-to-catalog')
  {
    assert.equal(await qwen.getByRole('button', { name: '下载模型', exact: true }).isEnabled(), true)
    await page.getByRole('button', { name: 'AI 文本翻译模型来源' }).click()
    assert.equal(await page.getByRole('option', { name: /^本地 Qwen3/ }).isDisabled(), true)
    await page.getByRole('option', { name: '应用默认模型', exact: true }).click()
    report.checks.push(initial.supported ? 'supported-platform-still-requires-installed-weights' : 'portable-file-management-does-not-enable-unsupported-inference')
  }
  const source = kotoba.getByText('这里提供 v2.0 GGML 基础识别权重。Kotoba 2.2 的角色区分及标点增强还需要独立后处理依赖，单独下载这些权重不代表已具备完整 2.2 能力。', { exact: true })
  assert.equal(await source.isVisible(), false)
  await kotoba.locator('summary').click()
  assert.equal(await source.isVisible(), true)
  await kotoba.locator('summary').click()
  report.checks.push('capability-and-provenance-disclosure')
  await hy.locator('summary').click()
  assert.equal(await hy.getByText('腾讯官方 HY-MT2 7B 普通 GGUF，Apache-2.0。提供 Q4_K_M、Q6_K、Q8_0，不包含特殊低比特版本。文件大小不是运行内存需求；速度和翻译效果需要按本机验证。', { exact: true }).isVisible(), true)
  assert.equal(await hy.getByText('https://huggingface.co/tencent/Hy-MT2-7B-GGUF', { exact: true }).isVisible(), true)
  await hy.locator('summary').click()
  report.checks.push('hy-official-source-and-memory-scope-disclosure')
  await index.locator('summary').click()
  assert.equal(await index.getByText('B站官方 Index-Translate 9B，提供全部 12 档纯文本 GGUF 精度，不包含视觉附件或语音模型。上游声明 Apache-2.0，许可正文来自官方项目。文件大小不是运行内存需求；速度和日中翻译效果需要按本机验证。', { exact: true }).isVisible(), true)
  assert.equal(await index.getByText('https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF', { exact: true }).isVisible(), true)
  await index.locator('summary').click()
  report.checks.push('index-official-source-license-and-text-only-scope-disclosure')
  for (const [name, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 640 }]]) {
    await page.setViewportSize(size)
    await page.getByRole('heading', { name: '模型商店', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    assert.equal(await qwen.evaluate(node => node.scrollWidth > node.clientWidth), false)
    assert.equal(await hy.evaluate(node => node.scrollWidth > node.clientWidth), false)
    assert.equal(await index.evaluate(node => node.scrollWidth > node.clientWidth), false)
    await page.screenshot({ path: path.join(output, `model-store-${name}.png`) })
    await hy.evaluate(node => node.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: path.join(output, `model-store-hy-${name}.png`) })
    await index.evaluate(node => node.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: path.join(output, `model-store-index-${name}.png`) })
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
