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
  const walk = (node: TestRenderer.ReactTestInstance): string[] =>
    node.children.flatMap((child) => typeof child === 'string' ? [child] : walk(child))
  return renderer ? walk(renderer.root).join('\n') : ''
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

  it('renders each exact-match candidate when the plugin returns an array', () => {
    const execution: PluginExecutionArtifact = {
      runtimeVersion: 'runtime-v2',
      artifactHash: 'artifact',
      targetFingerprint: 'targets',
      scope: 'all',
      targets: [{ kind: 'video', code: 'HMN-893' }],
      cases: [{
        target: { kind: 'video', code: 'HMN-893' },
        pluginResult: [
          { code: 'HMN-893', title: 'First detail', sourceUrl: 'https://example.test/hmn-893' },
          { code: 'HMN-893', title: 'Second detail', sourceUrl: 'https://example.test/dm/hmn-893' }
        ],
        effectiveResult: [
          { code: 'HMN-893', title: 'First detail' },
          { code: 'HMN-893', title: 'Second detail' }
        ],
        manifestCoverage: {
          returnedFieldIds: ['title', 'source'],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        runtimeAccepted: true
      }],
      executionPassed: true,
      reportPath: '/tmp/report.json'
    }

    act(() => {
      renderer = TestRenderer.create(
        <PluginDevResultPanel
          kind="video"
          dryRun={null}
          execution={execution}
          acceptance={{
            runtimeVersion: 'runtime-v2',
            artifactHash: 'artifact',
            targetFingerprint: 'targets',
            scope: 'all',
            executionPassed: true,
            ready: true,
            reportPath: '/tmp/report.json'
          }}
          stale={false}
          installState="not-installed"
        />
      )
    })

    const text = textContent()
    assert.match(text, /插件返回/)
    assert.match(text, /候选 1\/2/)
    assert.match(text, /候选 2\/2/)
    assert.match(text, /First detail/)
    assert.match(text, /Second detail/)
    assert.match(text, /生产有效结果/)
    assert.doesNotMatch(text, /无返回|空数组|无法展示该返回形状/)
    const details = renderer?.root.findAllByType('details') ?? []
    assert.equal(details.length, 1)
    assert.equal(details[0].props.open, true)
  })

  it('explains null and empty array plugin returns instead of hiding the section', () => {
    const execution: PluginExecutionArtifact = {
      runtimeVersion: 'runtime-v2',
      artifactHash: 'artifact',
      targetFingerprint: 'targets',
      scope: 'all',
      targets: [{ kind: 'video', code: 'MISS-1' }],
      cases: [{
        target: { kind: 'video', code: 'MISS-1' },
        pluginResult: null,
        effectiveResult: [],
        manifestCoverage: {
          returnedFieldIds: [],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        error: '未找到精确匹配',
        runtimeAccepted: false
      }],
      executionPassed: false,
      reportPath: '/tmp/report.json'
    }

    act(() => {
      renderer = TestRenderer.create(
        <PluginDevResultPanel
          kind="video"
          dryRun={null}
          execution={execution}
          acceptance={null}
          stale={false}
          installState="not-installed"
        />
      )
    })

    const text = textContent()
    assert.match(text, /插件返回\n无返回/)
    assert.match(text, /生产有效结果\n空数组/)
  })
})
