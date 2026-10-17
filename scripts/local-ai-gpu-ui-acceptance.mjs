import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAcceptanceDirectory, launchAcceptance, closeAcceptance, recordAcceptanceCleanup } from './playback-acceptance-support.mjs'

const output = path.resolve('output/playwright/local-gpu'), directory = createAcceptanceDirectory('local-gpu-')
await fs.mkdir(output, { recursive: true })
const runtime = path.resolve('out/ai-runtime-acceptance/gpu/runtime')
const selected = { qwen3: 'qwen3-q4_k_m', kotoba: 'kotoba-q5_0', 'hy-mt2-7b': 'hy-mt2-7b-q4_k_m' }
const usage = { subtitleRecognition: { model: 'kotoba', variant: selected.kotoba }, subtitleTranslation: { model: 'qwen3', variant: selected.qwen3 }, textTranslation: { model: 'qwen3', variant: selected.qwen3, mode: 'local' } }
await fs.writeFile(path.join(directory, 'local-models.json'), JSON.stringify({ version: 2, revision: 'gpu-ui-acceptance', directory: runtime, selected, usage, downloadSource: 'official', acceleration: { mode: 'auto' } }))
const report = { status: 'running', checks: [] }
let application
try {
  application = await launchAcceptance(directory, 'local-gpu-ui.log')
  const page = await application.firstWindow(), errors = []
  page.on('pageerror', cause => errors.push(cause.message))
  await page.waitForFunction(() => window.api?.settings)
  await page.evaluate(() => { window.location.hash = '/settings/models/local' })
  await page.getByRole('heading', { name: '计算设备', exact: true }).waitFor()
  await fs.writeFile(path.join(output, 'initial-structure.txt'), await page.locator('body').ariaSnapshot())
  const snapshot = () => page.evaluate(() => window.api.settings.getLocalModels())
  const waitPolicy = async (mode, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await snapshot()
      if (!state.operation && state.acceleration.policy.mode === mode) return
      assert.ok(Date.now() < deadline, `Device operation did not finish: ${state.operation}, ${state.downloadLabel}, ${state.downloadBytes}/${state.downloadTotal}`)
      await delay(100)
    }
  }
  assert.ok((await snapshot()).acceleration.devices.some(device => /RTX 4080/.test(device.name)))
  await application.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname !== '127.0.0.1') throw new Error('External inference blocked in isolated acceptance')
      return original(input, init)
    }
  })
  const translate = async expected => {
    const result = await page.evaluate(() => window.api.llm.translateToChinese('今日は天気がいいです。図書館に行きます。'))
    assert.match(result, /天气|图书馆/)
    assert.equal((await snapshot()).acceleration.translation.backend, expected)
    report.checks.push({ name: `product-ipc-${expected}`, result })
  }
  await translate('cuda')
  const control = page.getByRole('button', { name: '本地模型运行方式', exact: true })
  await control.focus(); await control.press('Enter'); await control.press('ArrowDown'); await control.press('Enter')
  await waitPolicy('cpu')
  await translate('cpu')
  await control.click(); await page.getByRole('option', { name: '自动选择', exact: true }).click()
  await waitPolicy('auto')
  await translate('cuda')
  report.checks.push('keyboard-mode-save-and-revisioned-product-ipc')
  await page.getByRole('button', { name: '文本 GPU 加速支持：检查与修复', exact: true }).click()
  await waitPolicy('auto', 120000)
  assert.equal((await snapshot()).acceleration.error, null)
  await translate('cuda')
  report.checks.push('product-ipc-verifies-installed-gpu-tools-and-resumes-inference')
  await page.evaluate(async () => {
    const state = await window.api.settings.getLocalModels()
    await window.api.settings.localModelCommand({ action: 'acceleration', expectedRevision: state.revision, policy: { mode: 'gpu', device: 'GPU-unavailable' } })
  })
  await translate('cpu')
  assert.match((await snapshot()).acceleration.translation.reason, /指定显卡不可用/)
  for (const [name, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 640 }]]) {
    await page.setViewportSize(size)
    await page.locator('[aria-label="本地模型计算设备"]').evaluate(node => node.scrollIntoView({ block: 'start' }))
    assert.equal(await page.locator('[aria-label="本地模型计算设备"]').evaluate(node => node.scrollWidth > node.clientWidth + 1), false)
    await page.screenshot({ path: path.join(output, `unavailable-gpu-${name}.png`) })
  }
  await control.click(); await page.getByRole('option', { name: '自动选择', exact: true }).click()
  await waitPolicy('auto'); await translate('cuda')
  report.checks.push('unavailable-selected-gpu-falls-back-through-product-ipc-with-readable-reason')
  await page.getByRole('button', { name: '重新检测并验证', exact: true }).click()
  await waitPolicy('auto')
  for (const theme of ['graphite', 'light']) {
    await page.evaluate(async theme => { await window.api.settings.update({ theme }); document.documentElement.dataset.theme = theme }, theme)
    for (const [name, size] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 640 }]]) {
      await page.setViewportSize(size)
      const card = page.locator('[aria-label="本地模型计算设备"]')
      const target = await card.count() ? card : page.getByRole('heading', { name: '计算设备', exact: true })
      await target.evaluate(node => node.scrollIntoView({ block: 'start' }))
      const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('main, section, [aria-label="本地模型计算设备"]')).filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1).map(node => node.getAttribute('aria-label') ?? node.tagName))
      assert.deepEqual(overflow, [])
      await page.screenshot({ path: path.join(output, `${theme}-${name}.png`) })
      report.checks.push(`${theme}-${name}-no-horizontal-overflow`)
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await control.focus(); assert.equal(await control.evaluate(node => node === document.activeElement), true)
  await page.reload(); await page.getByRole('heading', { name: '计算设备', exact: true }).waitFor()
  assert.equal((await snapshot()).acceleration.policy.mode, 'auto')
  assert.deepEqual(errors, [])
  report.checks.push('restart-read-preserves-policy-and-console-clean')
  report.status = 'pass'
} catch (cause) { report.status = 'failed'; report.failure = cause.stack ?? String(cause); throw cause }
finally {
  if (application) recordAcceptanceCleanup(report, await closeAcceptance(application))
  if (!application || (report.cleanup && !report.cleanup.forced && report.cleanup.code === 0)) {
    assert.equal(await fs.realpath(path.dirname(directory)), await fs.realpath(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('javdex-playback-acceptance-local-gpu-') && !(await fs.lstat(directory)).isSymbolicLink())
    await fs.rm(directory, { recursive: true, force: true })
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
