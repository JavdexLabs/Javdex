import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { PluginExecutionArtifact, PluginRunAcceptanceOutcome } from '@shared/pluginDevTypes'
import PluginDevResultPanel from './PluginDevResultPanel'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function textContent(): string {
  return renderer?.root.findAllByType('span')
    .flatMap((span) => span.children)
    .filter((value): value is string => typeof value === 'string')
    .join('\n') ?? ''
}

describe('PluginDevResultPanel manifest coverage', () => {
  it('separates actionable field ids from runtime-only and legacy information', () => {
    const execution: PluginExecutionArtifact = {
      runtimeVersion: 'runtime-v2',
      artifactHash: 'artifact',
      targetFingerprint: 'targets',
      scope: 'all',
      targets: [{ kind: 'actress', mainName: 'Alice', aliases: [] }],
      cases: [{
        target: { kind: 'actress', mainName: 'Alice', aliases: [] },
        pluginResult: { mainName: 'Alice', aliases: ['Ally'], sourceUrl: 'https://example.test/alice' },
        effectiveResult: { aliases: ['Ally'] },
        manifestCoverage: {
          returnedFieldIds: ['aliases'],
          undeclaredReturnedFieldIds: ['aliases'],
          runtimeOnlyKeys: [
            { key: 'mainName', role: 'identity' },
            { key: 'sourceUrl', role: 'diagnostic' }
          ]
        },
        legacyProjectionKeys: ['oldKey'],
        logs: [],
        runtimeAccepted: true
      }],
      executionPassed: true,
      reportPath: '/tmp/report.json'
    }
    const acceptance: PluginRunAcceptanceOutcome = {
      runtimeVersion: 'runtime-v2',
      artifactHash: 'artifact',
      targetFingerprint: 'targets',
      scope: 'all',
      executionPassed: true,
      ready: true,
      reportPath: '/tmp/report.json'
    }

    act(() => {
      renderer = TestRenderer.create(
        <PluginDevResultPanel
          kind="actress"
          dryRun={null}
          execution={execution}
          acceptance={acceptance}
          stale={false}
          installState="not-installed"
        />
      )
    })

    const text = textContent()
    assert.match(text, /插件已返回但 manifest 未声明\naliases/)
    assert.match(text, /运行\/调试信息，不属于 supportedFields\nmainName、sourceUrl/)
    assert.match(text, /旧版投影记录\noldKey\n（仅供历史查看）/)
    assert.match(text, /机械验收通过，可安装/)
    assert.doesNotMatch(text, /完整生产运行已就绪|被 supportedFields 投影丢弃/)
  })
})
