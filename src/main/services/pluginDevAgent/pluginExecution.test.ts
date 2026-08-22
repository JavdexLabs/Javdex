import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginDevDryRunInput, PluginDevDryRunResult } from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { PluginExecutionModule, PLUGIN_RUNTIME_VERSION } from './pluginExecution'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function reportsDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-execution-'))
  directories.push(directory)
  return directory
}

function packageValue(kind: 'video' | 'actress'): ScraperPluginPackage {
  return {
    schemaVersion: 1,
    kind,
    name: `${kind}-execution-test`,
    version: '1.0.0',
    description: '',
    supportedFields: kind === 'video' ? ['title'] : ['birthDate'],
    code: kind === 'video'
      ? 'async function parseVideo(ctx) { return { code: ctx.code, title: "x" } }\nmodule.exports = { parseVideo }'
      : 'async function parseActress(ctx) { return { mainName: ctx.mainName } }\nmodule.exports = { parseActress }'
  }
}

describe('PluginExecutionModule', () => {
  it('passes only the typed actress runtime identity and preserves production facts', async () => {
    const calls: PluginDevDryRunInput[] = []
    const module = new PluginExecutionModule({
      run: async (input): Promise<PluginDevDryRunResult> => {
        calls.push(structuredClone(input))
        return {
          ok: true,
          result: { birthDate: '1993-08-16' },
          pluginResult: {
            mainName: '三上悠亜',
            aliases: ['Yua Mikami'],
            birthDate: '1993-08-16',
            sourceUrl: 'https://example.test/profile'
          },
          effectiveResult: { birthDate: '1993-08-16' },
          unrecognizedResultKeys: ['legacyAvatar'],
          logs: ['done']
        }
      }
    })
    const target = { kind: 'actress' as const, mainName: '三上悠亜', aliases: ['Yua Mikami'] }
    const artifact = await module.run({
      package: packageValue('actress'),
      targets: [target],
      scope: 'all',
      reportsDirectory: reportsDirectory(),
      signal: new AbortController().signal
    })

    assert.deepEqual(calls[0]?.runTarget, target)
    assert.equal(Object.hasOwn(calls[0] ?? {}, 'testTarget'), false)
    assert.deepEqual(artifact.cases[0]?.manifestCoverage, {
      returnedFieldIds: ['birthDate', 'aliases'],
      undeclaredReturnedFieldIds: ['aliases'],
      runtimeOnlyKeys: [
        { key: 'mainName', role: 'identity' },
        { key: 'sourceUrl', role: 'diagnostic' }
      ]
    })
    assert.deepEqual(artifact.cases[0]?.unrecognizedResultKeys, ['legacyAvatar'])
    assert.equal(artifact.cases[0]?.runtimeAccepted, true)
    assert.equal(artifact.executionPassed, true)
    assert.equal(artifact.runtimeVersion, PLUGIN_RUNTIME_VERSION)
    assert.equal(fs.existsSync(artifact.reportPath), true)
  })

  it('records rejected production results without adding semantic issue classifications', async () => {
    const module = new PluginExecutionModule({
      run: async () => ({
        ok: false,
        result: null,
        pluginResult: { code: 'WRONG-1', title: 'A perfectly plausible title' },
        effectiveResult: null,
        logs: ['candidate rejected by production identity filter'],
        error: '生产运行时没有接受候选'
      })
    })
    const artifact = await module.run({
      package: packageValue('video'),
      targets: [{ kind: 'video', code: 'RIGHT-1' }],
      scope: 'all',
      reportsDirectory: reportsDirectory(),
      signal: new AbortController().signal
    })

    assert.equal(artifact.executionPassed, false)
    assert.equal(artifact.cases[0]?.runtimeAccepted, false)
    assert.deepEqual(artifact.cases[0]?.pluginResult, {
      code: 'WRONG-1', title: 'A perfectly plausible title'
    })
    assert.equal(Object.hasOwn(artifact, 'blockingIssues'), false)
  })

  it('does not accept undefined or runtime-only output as a material production result', async () => {
    const module = new PluginExecutionModule({
      run: async () => ({
        ok: true,
        result: { avatarUrl: undefined },
        pluginResult: { mainName: 'Alice', sourceUrl: 'https://example.test/alice', avatarUrl: undefined },
        effectiveResult: { avatarUrl: undefined },
        logs: []
      })
    })
    const artifact = await module.run({
      package: packageValue('actress'),
      targets: [{ kind: 'actress', mainName: 'Alice', aliases: [] }],
      scope: 'all',
      reportsDirectory: reportsDirectory(),
      signal: new AbortController().signal
    })

    assert.equal(artifact.executionPassed, false)
    assert.equal(artifact.cases[0]?.runtimeAccepted, false)
    assert.deepEqual(artifact.cases[0]?.manifestCoverage.runtimeOnlyKeys, [
      { key: 'mainName', role: 'identity' },
      { key: 'sourceUrl', role: 'diagnostic' }
    ])
  })

  it('does not accept a video source link without any material scraped field', async () => {
    const module = new PluginExecutionModule({
      run: async () => ({
        ok: true,
        result: { code: 'ABC-1', sourceUrl: 'https://example.test/video' },
        pluginResult: { code: 'ABC-1', sourceUrl: 'https://example.test/video' },
        effectiveResult: { code: 'ABC-1', sourceUrl: 'https://example.test/video' },
        logs: []
      })
    })
    const pkg: ScraperPluginPackage = { ...packageValue('video'), supportedFields: ['source'] }
    const artifact = await module.run({
      package: pkg,
      targets: [{ kind: 'video', code: 'ABC-1' }],
      scope: 'all',
      reportsDirectory: reportsDirectory(),
      signal: new AbortController().signal
    })

    assert.equal(artifact.executionPassed, false)
    assert.equal(artifact.cases[0]?.runtimeAccepted, false)
  })
})
