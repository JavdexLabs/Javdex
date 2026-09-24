import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginExecutionArtifact } from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { pluginArtifactHash } from './pluginArtifact'
import { PLUGIN_RUNTIME_VERSION, pluginRunTargetFingerprint } from './pluginExecution'
import { PluginRunAcceptanceModule } from './pluginRunAcceptance'

const pkg: ScraperPluginPackage = {
  schemaVersion: 1,
  kind: 'video',
  name: 'acceptance-test',
  version: '1.0.0',
  description: '',
  supportedFields: ['title'],
  code: 'async function parseVideo(ctx) { return { code: ctx.code, title: "wrong but accepted" } }\nmodule.exports = { parseVideo }'
}
const targets = [{ kind: 'video' as const, code: 'ABC-1' }]

function artifact(overrides: Partial<PluginExecutionArtifact> = {}): PluginExecutionArtifact {
  return {
    runtimeVersion: PLUGIN_RUNTIME_VERSION,
    artifactHash: pluginArtifactHash(pkg),
    targetFingerprint: pluginRunTargetFingerprint(targets),
    scope: 'all',
    targets,
    cases: [{
      target: targets[0],
      pluginResult: { code: 'ABC-1', title: 'wrong but accepted', coverUrl: 'https://x/cover.jpg' },
      effectiveResult: { code: 'ABC-1', title: 'wrong but accepted' },
      manifestCoverage: {
        returnedFieldIds: ['title', 'cover'],
        undeclaredReturnedFieldIds: ['cover'],
        runtimeOnlyKeys: []
      },
      logs: [],
      runtimeAccepted: true
    }],
    executionPassed: true,
    reportPath: '/tmp/report.json',
    ...overrides
  }
}

describe('PluginRunAcceptanceModule', () => {
  const gate = new PluginRunAcceptanceModule()

  it('accepts an exact full production artifact without judging content or manifest coverage', () => {
    const decision = gate.evaluate({ package: pkg, targets, execution: artifact() })
    assert.equal(decision.ready, true)
    assert.deepEqual(decision.reasons, [])
  })

  it('keeps readiness when only the plugin display name changes', () => {
    const decision = gate.evaluate({
      package: { ...pkg, name: 'renamed-after-ready' },
      targets,
      execution: artifact()
    })
    assert.equal(decision.ready, true)
    assert.deepEqual(decision.reasons, [])
    assert.equal(pluginArtifactHash({ ...pkg, name: 'renamed-after-ready' }), pluginArtifactHash(pkg))
  })

  it('rejects targeted, stale package, stale target, stale runtime, and failed execution artifacts', () => {
    assert.equal(gate.evaluate({ package: pkg, targets, execution: artifact({ scope: 'targeted' }) }).ready, false)
    assert.deepEqual(
      gate.evaluate({ package: pkg, targets, execution: artifact({ scope: 'targeted' }) }).reasons,
      ['wrong_scope']
    )
    assert.equal(gate.evaluate({
      package: { ...pkg, code: `${pkg.code}\n// changed` }, targets, execution: artifact()
    }).ready, false)
    assert.equal(gate.evaluate({
      package: pkg,
      targets: [{ kind: 'video', code: 'OTHER-1' }],
      execution: artifact()
    }).ready, false)
    assert.equal(gate.evaluate({
      package: pkg, targets, execution: artifact({ runtimeVersion: 'runtime-old' })
    }).ready, false)
    assert.equal(gate.evaluate({
      package: pkg, targets, execution: artifact({ executionPassed: false })
    }).ready, false)
    assert.equal(gate.evaluate({
      package: pkg, targets, execution: artifact({ cases: [] })
    }).ready, false)
    assert.equal(gate.evaluate({
      package: pkg,
      targets,
      execution: artifact({ targets: [{ kind: 'video', code: 'OTHER-1' }] })
    }).ready, false)
  })

  it('never accepts a vacuous full execution with no session targets or cases', () => {
    const emptyTargets: typeof targets = []
    const decision = gate.evaluate({
      package: pkg,
      targets: emptyTargets,
      execution: artifact({
        targets: [],
        cases: [],
        targetFingerprint: pluginRunTargetFingerprint(emptyTargets),
        executionPassed: true
      })
    })

    assert.equal(decision.ready, false)
    assert.ok(decision.reasons.includes('execution_failed'))
    assert.ok(decision.reasons.includes('target_mismatch'))
  })

  it('treats a successful proper-subset run as wrong_scope, not execution_failed', () => {
    const sessionTargets = [
      { kind: 'video' as const, code: 'ABC-1' },
      { kind: 'video' as const, code: 'ABC-2' }
    ]
    const subset = [sessionTargets[0]]
    const decision = gate.evaluate({
      package: pkg,
      targets: sessionTargets,
      execution: artifact({
        scope: 'targeted',
        targets: subset,
        targetFingerprint: pluginRunTargetFingerprint(subset),
        cases: [{
          target: subset[0],
          pluginResult: { code: 'ABC-1', title: 'ok' },
          effectiveResult: { code: 'ABC-1', title: 'ok' },
          manifestCoverage: {
            returnedFieldIds: ['title'],
            undeclaredReturnedFieldIds: [],
            runtimeOnlyKeys: []
          },
          logs: [],
          runtimeAccepted: true
        }]
      })
    })
    assert.equal(decision.ready, false)
    assert.deepEqual(decision.reasons, ['wrong_scope'])
  })

  it('keeps execution_failed when a targeted subset itself failed', () => {
    const sessionTargets = [
      { kind: 'video' as const, code: 'ABC-1' },
      { kind: 'video' as const, code: 'ABC-2' }
    ]
    const subset = [sessionTargets[0]]
    const decision = gate.evaluate({
      package: pkg,
      targets: sessionTargets,
      execution: artifact({
        scope: 'targeted',
        targets: subset,
        targetFingerprint: pluginRunTargetFingerprint(subset),
        executionPassed: false,
        cases: [{
          target: subset[0],
          pluginResult: null,
          effectiveResult: null,
          manifestCoverage: {
            returnedFieldIds: [],
            undeclaredReturnedFieldIds: [],
            runtimeOnlyKeys: []
          },
          logs: [],
          error: 'sandbox crash',
          runtimeAccepted: false
        }]
      })
    })
    assert.equal(decision.ready, false)
    assert.deepEqual(decision.reasons, ['execution_failed', 'wrong_scope'])
  })
})
