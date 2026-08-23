import type {
  PluginDevRunTarget,
  PluginExecutionArtifact,
  PluginRunAcceptanceOutcome
} from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { normalizePackageForDev } from '../pluginDevService'
import { pluginArtifactHash } from './pluginArtifact'
import { PLUGIN_RUNTIME_VERSION, pluginRunTargetFingerprint } from './pluginExecution'

export interface PluginRunAcceptanceInput {
  package: ScraperPluginPackage
  targets: readonly PluginDevRunTarget[]
  execution?: PluginExecutionArtifact
}

export type PluginRunAcceptanceReason =
  | 'missing_execution'
  | 'execution_failed'
  | 'wrong_scope'
  | 'stale_runtime'
  | 'stale_artifact'
  | 'target_mismatch'

export type PluginRunRecoveryReason = PluginRunAcceptanceReason | 'workspace_invalid'

export interface PluginRunAcceptanceProjection {
  installReady: boolean
  reasons: PluginRunRecoveryReason[]
}

export interface PluginRunAcceptanceDecision {
  ready: boolean
  reasons: PluginRunAcceptanceReason[]
  outcome?: PluginRunAcceptanceOutcome
}

export function projectPluginRunAcceptance(
  decision: Pick<PluginRunAcceptanceDecision, 'ready' | 'reasons'>
): PluginRunAcceptanceProjection {
  return {
    installReady: decision.ready,
    reasons: [...decision.reasons]
  }
}

/** Pure final gate: current full production execution is the only source of readiness. */
export class PluginRunAcceptanceModule {
  evaluate(input: PluginRunAcceptanceInput): PluginRunAcceptanceDecision {
    const execution = input.execution
    if (!execution) return { ready: false, reasons: ['missing_execution'] }
    const reasons: PluginRunAcceptanceDecision['reasons'] = []
    const expectedTargetFingerprint = pluginRunTargetFingerprint(input.targets)
    const executionTargetsMatch = pluginRunTargetFingerprint(execution.targets) === expectedTargetFingerprint
    const acceptedCaseTargets = execution.cases
      .filter((item) => item.runtimeAccepted)
      .map((item) => item.target)
    const sessionCasesMatch = pluginRunTargetFingerprint(acceptedCaseTargets) === expectedTargetFingerprint
    const ownCasesMatch = pluginRunTargetFingerprint(acceptedCaseTargets) ===
      pluginRunTargetFingerprint(execution.targets)
    const hasOwnCompleteRun = execution.targets.length > 0 &&
      execution.cases.length > 0 &&
      ownCasesMatch
    const hasSessionCompleteRun = input.targets.length > 0 &&
      execution.targets.length > 0 &&
      execution.cases.length > 0
    if (execution.scope === 'targeted') {
      if (!hasOwnCompleteRun || !execution.executionPassed) reasons.push('execution_failed')
      reasons.push('wrong_scope')
    } else {
      if (!hasSessionCompleteRun || !execution.executionPassed || !sessionCasesMatch) {
        reasons.push('execution_failed')
      }
    }
    if (execution.runtimeVersion !== PLUGIN_RUNTIME_VERSION) reasons.push('stale_runtime')
    if (execution.artifactHash !== pluginArtifactHash(normalizePackageForDev(input.package))) {
      reasons.push('stale_artifact')
    }
    if (
      execution.scope !== 'targeted' &&
      (!hasSessionCompleteRun || execution.targetFingerprint !== expectedTargetFingerprint || !executionTargetsMatch)
    ) {
      reasons.push('target_mismatch')
    }
    const ready = reasons.length === 0
    return {
      ready,
      reasons,
      outcome: {
        runtimeVersion: execution.runtimeVersion,
        artifactHash: execution.artifactHash,
        targetFingerprint: execution.targetFingerprint,
        scope: execution.scope,
        executionPassed: execution.executionPassed,
        ready,
        reportPath: execution.reportPath
      }
    }
  }
}

export const pluginRunAcceptance = new PluginRunAcceptanceModule()
