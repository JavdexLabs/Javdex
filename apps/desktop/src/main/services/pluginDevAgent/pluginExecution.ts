import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  PluginDevDryRunInput,
  PluginDevDryRunResult,
  PluginDevRunTarget,
  PluginExecutionArtifact,
  PluginExecutionCase
} from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { normalizeRunTargets } from '@shared/pluginDevKindProfile'
import {
  dryRunPluginPackage,
  normalizePackageForDev,
  PLUGIN_UNMATCHED_TARGET_ERROR
} from '../pluginDevService'

const LEGACY_EMPTY_OR_INVALID_ERROR = '插件返回为空或结果格式无效'
import { pluginArtifactHash } from './pluginArtifact'
import { pluginResultContract } from '@shared/pluginResultContract'

export const PLUGIN_RUNTIME_VERSION = 'runtime-v1'

interface PluginRuntimePort {
  run(input: PluginDevDryRunInput, signal: AbortSignal): Promise<PluginDevDryRunResult>
}

export interface PluginExecutionInput {
  package: ScraperPluginPackage
  targets: PluginDevRunTarget[]
  scope: 'targeted' | 'all'
  reportsDirectory: string
  signal: AbortSignal
}

const productionRuntime: PluginRuntimePort = {
  run: (input, signal) => dryRunPluginPackage(input, { signal })
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function pluginRunTargetFingerprint(targets: readonly PluginDevRunTarget[]): string {
  return hash(normalizeRunTargets(targets))
}

export function isPluginExecutionCloudflareInterruption(
  execution: PluginExecutionArtifact
): boolean {
  const failures = execution.cases.filter((item) => !item.runtimeAccepted)
  return failures.length > 0 && failures.every((item) =>
    /(?:Cloudflare.*\u9a8c\u8bc1|\u9a8c\u8bc1.*Cloudflare|\u9a8c\u8bc1\u8d85\u65f6)/iu.test(item.error ?? '')
  )
}

function isEmptyPluginResult(result: unknown): boolean {
  return result == null || (Array.isArray(result) && result.length === 0)
}

/** Full-scope empty returns are a miss, not a broken plugin shape. */
export function isPluginExecutionUnmatchedTargets(
  execution: PluginExecutionArtifact
): boolean {
  return execution.scope === 'all' &&
    execution.cases.length > 0 &&
    execution.cases.every((item) =>
      !item.runtimeAccepted &&
      isEmptyPluginResult(item.pluginResult) &&
      (item.error === PLUGIN_UNMATCHED_TARGET_ERROR ||
        item.error === LEGACY_EMPTY_OR_INVALID_ERROR)
    )
}

function atomicReport(filePath: string, artifact: PluginExecutionArtifact): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, filePath)
}

/** Runs the production plugin contract and records facts without making semantic judgments. */
export class PluginExecutionModule {
  constructor(private readonly runtime: PluginRuntimePort = productionRuntime) {}

  async run(input: PluginExecutionInput): Promise<PluginExecutionArtifact> {
    input.signal.throwIfAborted()
    const pkg = normalizePackageForDev(input.package)
    const targets = normalizeRunTargets(input.targets)
    if (targets.length === 0) throw new Error('插件执行至少需要一个运行目标')
    if (targets.some((target) => target.kind !== pkg.kind)) {
      throw new Error('运行目标 kind 与插件 kind 不一致')
    }

    const artifactHash = pluginArtifactHash(pkg)
    const targetFingerprint = pluginRunTargetFingerprint(targets)
    const cases: PluginExecutionCase[] = []
    for (const target of targets) {
      input.signal.throwIfAborted()
      const result = await this.runtime.run({ package: pkg, runTarget: target }, input.signal)
      const pluginResult = result.pluginResult ?? result.result
      const effectiveResult = result.effectiveResult ?? result.result
      const analysis = pluginResultContract.analyze({
        kind: pkg.kind,
        pluginResult,
        effectiveResult,
        declaredFields: pkg.supportedFields ?? []
      })
      const runtimeAccepted = result.ok && analysis.materialAccepted
      cases.push({
        target,
        pluginResult,
        effectiveResult,
        manifestCoverage: analysis.manifestCoverage,
        unrecognizedResultKeys: result.unrecognizedResultKeys ?? [],
        logs: result.logs,
        ...(result.error ? { error: result.error } : {}),
        runtimeAccepted
      })
    }

    const executionPassed = cases.every((item) => item.runtimeAccepted)
    const reportId = hash({
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash,
      targetFingerprint,
      scope: input.scope
    }).slice(0, 20)
    const reportPath = path.join(path.resolve(input.reportsDirectory), `${reportId}.json`)
    const artifact: PluginExecutionArtifact = {
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      artifactHash,
      targetFingerprint,
      scope: input.scope,
      targets,
      cases,
      executionPassed,
      reportPath
    }
    atomicReport(reportPath, artifact)
    return artifact
  }
}

export const pluginExecution = new PluginExecutionModule()
