import fs from 'node:fs'
import path from 'node:path'
import type {
  PluginDevAgentStartInput,
  PluginDevChoiceDecision,
  PluginDevRunTarget
} from '@shared/pluginDevTypes'
import {
  configuredRunTargets,
  normalizeRunTargets,
  normalizeTestTargets
} from '@shared/pluginDevKindProfile'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import { normalizePackageForDev } from '../pluginDevService'
import { pluginArtifactHash } from './pluginArtifact'
import {
  buildRunInstructionSet,
  PLUGIN_DEV_INSTRUCTION_SET_VERSION
} from './pluginDevInstructions'
import type { PluginRunAcceptanceProjection } from './pluginRunAcceptance'

const MANIFEST_FILE = 'plugin.json'
const CODE_FILE = 'index.js'
const TASK_FILE = 'task.json'
const DECISIONS_FILE = path.join('.javdex', 'decisions.json')
const DEV_NOTES_FILE = path.join('.javdex', 'dev-notes.md')
const LATEST_DRY_RUN_FILE = path.join('.javdex', 'latest-dry-run.json')
const REPORTS_DIRECTORY = path.join('.javdex', 'reports')
const PLUGIN_DEV_SKILL_FILE = path.join('.agents', 'skills', 'javdex-plugin-dev', 'SKILL.md')
const BROWSER_SKILL_FILE = path.join('.agents', 'skills', 'javdex-browser-operation', 'SKILL.md')

interface WorkspaceManifest extends Omit<ScraperPluginPackage, 'code'> {
  codeFile: typeof CODE_FILE
}

export interface PluginDevLatestDryRun {
  schemaVersion: 1
  status: 'completed'
  artifactHash: string
  reportPath: string
  scope: 'targeted' | 'all'
  runtimeVersion: string
  targetFingerprint: string
  executionPassed: boolean
  cases: Array<Record<string, unknown>>
  currentAcceptance: PluginRunAcceptanceProjection
}

interface PluginDevInitialDryRunState {
  schemaVersion: 1
  status: 'not_run'
  currentAcceptance: PluginRunAcceptanceProjection
}

const INITIAL_DRY_RUN_STATE: PluginDevInitialDryRunState = {
  schemaVersion: 1,
  status: 'not_run',
  currentAcceptance: {
    installReady: false,
    reasons: ['missing_execution']
  }
}

const DEV_NOTES_TEMPLATE = `# 插件开发笔记

## 已确认页面

- 尚未记录。

## 字段范围与覆盖

- 尚未评估；确认精确页面后记录全部明确字段及其实现状态。

## 当前实现

- 尚未记录。

## 未完成事项或下一步

- 尚未评估；没有明确未完成项时写“无”。

## 最新 dry-run

- 尚未运行；真实结果由宿主写入 \`.javdex/latest-dry-run.json\`。
`

export interface PluginWorkspaceSnapshot {
  directory: string
  package: ScraperPluginPackage
  artifactHash: string
  files: {
    manifest: string
    code: string
    task: string
    decisions: string
    devNotes: string
    latestDryRun: string
    reportsDirectory: string
    pluginSkill: string
    browserSkill: string
  }
}

export interface PluginWorkspaceOpenInput {
  directory: string
  task: PluginDevAgentStartInput
  package: ScraperPluginPackage
  /** Restored runs must keep the Skill/resources frozen in their persisted run configuration. */
  resourcePolicy?: 'refresh' | 'preserve-frozen'
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, filePath)
}

function workspaceManifest(pkg: ScraperPluginPackage): WorkspaceManifest {
  const { code: _code, ...manifest } = pkg
  return { ...manifest, codeFile: CODE_FILE }
}

function assertWorkspacePath(directory: string): string {
  const resolved = path.resolve(directory)
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error('插件工作区目录无效')
  }
  return resolved
}

interface ExistingTaskResource {
  instructionSetVersion?: number
  kind?: unknown
  runTargets: PluginDevRunTarget[]
}

function readExistingTask(filePath: string): ExistingTaskResource | undefined {
  if (!fs.existsSync(filePath)) return undefined
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const candidates = Array.isArray(raw.runTargets)
      ? raw.runTargets.flatMap((value): PluginDevRunTarget[] => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const target = value as Record<string, unknown>
          if (target.kind === 'video' && typeof target.code === 'string') {
            return [{ kind: 'video', code: target.code }]
          }
          if (target.kind === 'actress' && typeof target.mainName === 'string') {
            return [{
              kind: 'actress',
              mainName: target.mainName,
              aliases: Array.isArray(target.aliases)
                ? target.aliases.filter((alias): alias is string => typeof alias === 'string')
                : []
            }]
          }
          return []
        })
      : []
    return {
      instructionSetVersion: typeof raw.instructionSetVersion === 'number'
        ? raw.instructionSetVersion
        : undefined,
      kind: raw.kind,
      runTargets: normalizeRunTargets(candidates)
    }
  } catch {
    return undefined
  }
}

/**
 * Owns the durable plugin draft file layout. Callers only exchange normalized packages and
 * snapshots; JSON/file layout and atomic writes stay local to this Module.
 */
export class PluginWorkspaceModule {
  filePaths(directoryInput: string): PluginWorkspaceSnapshot['files'] {
    const directory = assertWorkspacePath(directoryInput)
    return {
      manifest: path.join(directory, MANIFEST_FILE),
      code: path.join(directory, CODE_FILE),
      task: path.join(directory, TASK_FILE),
      decisions: path.join(directory, DECISIONS_FILE),
      devNotes: path.join(directory, DEV_NOTES_FILE),
      latestDryRun: path.join(directory, LATEST_DRY_RUN_FILE),
      reportsDirectory: path.join(directory, REPORTS_DIRECTORY),
      pluginSkill: path.join(directory, PLUGIN_DEV_SKILL_FILE),
      browserSkill: path.join(directory, BROWSER_SKILL_FILE)
    }
  }

  open(input: PluginWorkspaceOpenInput): PluginWorkspaceSnapshot {
    const directory = assertWorkspacePath(input.directory)
    fs.mkdirSync(directory, { recursive: true })
    fs.mkdirSync(path.join(directory, REPORTS_DIRECTORY), { recursive: true })

    const manifestPath = path.join(directory, MANIFEST_FILE)
    const codePath = path.join(directory, CODE_FILE)
    const taskPath = path.join(directory, TASK_FILE)
    const decisionsPath = path.join(directory, DECISIONS_FILE)
    const devNotesPath = path.join(directory, DEV_NOTES_FILE)
    const latestDryRunPath = path.join(directory, LATEST_DRY_RUN_FILE)
    const existingDraft = fs.existsSync(manifestPath) && fs.existsSync(codePath)
    const existingTask = readExistingTask(taskPath)

    if (!existingDraft) this.writePackage(directory, input.package)
    if (!existingTask ||
        (input.resourcePolicy !== 'preserve-frozen' &&
          existingTask.instructionSetVersion !== PLUGIN_DEV_INSTRUCTION_SET_VERSION)) {
      const currentTargets = configuredRunTargets(
        input.task.kind,
        normalizeTestTargets(input.task)
      )
      const preservedTargets = currentTargets.length > 0
        ? currentTargets
        : existingTask?.kind === input.task.kind
          ? existingTask.runTargets.filter((target) => target.kind === input.task.kind)
          : []
      const resources = buildRunInstructionSet({
        task: input.task,
        runTargets: preservedTargets
      }).workspaceResources
      for (const [relativePath, content] of Object.entries(resources)) {
        if (relativePath === TASK_FILE) continue
        atomicWrite(path.join(directory, relativePath), content)
      }
      // task.json is the commit marker: a partial refresh is retried on the next open.
      atomicWrite(taskPath, resources[TASK_FILE])
    }
    if (!fs.existsSync(decisionsPath)) atomicWrite(decisionsPath, '[]\n')
    if (!fs.existsSync(devNotesPath)) atomicWrite(devNotesPath, DEV_NOTES_TEMPLATE)
    if (!fs.existsSync(latestDryRunPath)) {
      atomicWrite(latestDryRunPath, `${JSON.stringify(INITIAL_DRY_RUN_STATE, null, 2)}\n`)
    }

    return this.snapshot(directory)
  }

  writePackage(directoryInput: string, packageInput: ScraperPluginPackage): PluginWorkspaceSnapshot {
    const directory = assertWorkspacePath(directoryInput)
    const pkg = normalizePackageForDev(packageInput)
    fs.mkdirSync(directory, { recursive: true })
    atomicWrite(
      path.join(directory, MANIFEST_FILE),
      `${JSON.stringify(workspaceManifest(pkg), null, 2)}\n`
    )
    atomicWrite(path.join(directory, CODE_FILE), `${pkg.code.trimEnd()}\n`)
    return this.snapshot(directory)
  }

  snapshot(directoryInput: string): PluginWorkspaceSnapshot {
    const directory = assertWorkspacePath(directoryInput)
    const manifestPath = path.join(directory, MANIFEST_FILE)
    const codePath = path.join(directory, CODE_FILE)
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<WorkspaceManifest>
    if (rawManifest.codeFile !== CODE_FILE) {
      throw new Error(`plugin.json codeFile 必须为 ${CODE_FILE}`)
    }
    if (!Array.isArray(rawManifest.supportedFields)) {
      throw new Error('plugin.json supportedFields 必须是字段 id 数组；create 草稿可以使用空数组。')
    }
    const code = fs.readFileSync(codePath, 'utf8')
    const { codeFile: _codeFile, ...manifest } = rawManifest
    const pkg = normalizePackageForDev({ ...manifest, code })
    return {
      directory,
      package: pkg,
      artifactHash: pluginArtifactHash(pkg),
      files: this.filePaths(directory)
    }
  }

  recordDecision(
    directoryInput: string,
    decision: PluginDevChoiceDecision & { at?: string }
  ): void {
    const directory = assertWorkspacePath(directoryInput)
    const filePath = path.join(directory, DECISIONS_FILE)
    const current = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
      : []
    const rows = Array.isArray(current) ? current.filter((row) => row && typeof row === 'object') : []
    const next = [
      ...rows.filter((row) => (row as { requestId?: unknown }).requestId !== decision.requestId),
      { ...decision, at: decision.at ?? new Date().toISOString() }
    ]
    atomicWrite(filePath, `${JSON.stringify(next, null, 2)}\n`)
  }

  updateRunTargets(directoryInput: string, runTargets: readonly PluginDevRunTarget[]): void {
    const directory = assertWorkspacePath(directoryInput)
    const filePath = path.join(directory, TASK_FILE)
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    atomicWrite(filePath, `${JSON.stringify({
      ...current,
      runTargets: normalizeRunTargets(runTargets)
    }, null, 2)}\n`)
  }

  recordLatestDryRun(directoryInput: string, latest: PluginDevLatestDryRun): void {
    const directory = assertWorkspacePath(directoryInput)
    atomicWrite(
      path.join(directory, LATEST_DRY_RUN_FILE),
      `${JSON.stringify(latest, null, 2)}\n`
    )
  }

  updateCurrentAcceptance(
    directoryInput: string,
    currentAcceptance: PluginRunAcceptanceProjection
  ): void {
    const directory = assertWorkspacePath(directoryInput)
    const filePath = path.join(directory, LATEST_DRY_RUN_FILE)
    let current: Record<string, unknown> = { ...structuredClone(INITIAL_DRY_RUN_STATE) }
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>
        }
      } catch {
        // Replace an unreadable recovery projection without touching execution reports.
      }
    }
    atomicWrite(filePath, `${JSON.stringify({
      ...current,
      schemaVersion: 1,
      currentAcceptance
    }, null, 2)}\n`)
  }

  async remove(directoryInput: string): Promise<void> {
    const directory = assertWorkspacePath(directoryInput)
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
}

export const pluginWorkspace = new PluginWorkspaceModule()
