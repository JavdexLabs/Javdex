import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { localAiDirectories } from './modelStorage'

const requireDependency = createRequire(import.meta.url)
const code = transpileModule(readFileSync(new URL('./desktopLocalModels.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

function startupModels(root: string) {
  const exports = {} as typeof import('./desktopLocalModels')
  runInNewContext(code, { exports, process, console,
    require(name: string): unknown {
      if (name === 'electron') return { app: { getPath: () => root, getAppPath: () => root, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }
      if (name === '../../ipc/appContractAdapter') return { appEventAdapter: { send() {} } }
      if (name === './localModelManager') {
        const actual = requireDependency(name) as typeof import('./localModelManager')
        return { createLocalModelManager: (directory: string, options: Parameters<typeof actual.createLocalModelManager>[1]) =>
          actual.createLocalModelManager(directory, { ...options, runtimeSupported: () => false, detectDevices: async () => [] }) }
      }
      return requireDependency(name)
    }
  }, { filename: 'desktopLocalModels.ts' })
  return exports
}

test('fresh startup stays local when cloud bootstrap writes before the lazy first model read', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-startup-fresh-')))
  const desktop = startupModels(root)
  t.after(async () => { await desktop.closeLocalModels(); await fs.rm(root, { recursive: true, force: true }) })
  desktop.captureInitialLocalModelMode()
  const startup = readFileSync(new URL('../../appMain.ts', import.meta.url), 'utf8')
  assert.ok(startup.indexOf('captureInitialLocalModelMode()') >= 0)
  assert.ok(startup.indexOf('captureInitialLocalModelMode()') < startup.indexOf('await createDesktopRuntime('))
  assert.ok(startup.indexOf('captureInitialLocalModelMode()') < startup.indexOf('modelManagement.read()'))
  await assert.rejects(fs.access(path.join(root, 'local-models.json')), { code: 'ENOENT' }, 'capturing defaults must remain lazy')
  const cloud = JSON.stringify({ schemaVersion: 4, connections: [], models: [], assignments: [] })
  await fs.writeFile(path.join(root, 'ai-configuration.json'), cloud)
  desktop.captureInitialLocalModelMode() // Repeated setup cannot change this launch's initial identity.
  assert.equal(await desktop.getLocalModels().mode(), 'local')
  assert.equal(await fs.readFile(path.join(root, 'ai-configuration.json'), 'utf8'), cloud)
  await desktop.closeLocalModels()
  assert.equal(await desktop.getLocalModels().mode(), 'local')
})

test('startup preserves pre-existing 0.8.0 cloud translation without editing its configuration', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-startup-old-')))
  const cloud = JSON.stringify({ schemaVersion: 3, assignments: [{ workloadId: 'app-default', model: { mode: 'explicit', modelRef: 'saved-model' } }] })
  await fs.writeFile(path.join(root, 'ai-configuration.json'), cloud)
  const desktop = startupModels(root)
  t.after(async () => { await desktop.closeLocalModels(); await fs.rm(root, { recursive: true, force: true }) })
  desktop.captureInitialLocalModelMode()
  assert.equal(await desktop.getLocalModels().mode(), 'app-default')
  assert.equal(await fs.readFile(path.join(root, 'ai-configuration.json'), 'utf8'), cloud)
  const { usage } = await desktop.getLocalModels().snapshot()
  await desktop.getLocalModels().setUsage({ ...usage, textTranslation: { ...usage.textTranslation, mode: 'local' } })
  await desktop.closeLocalModels()
  assert.equal(await desktop.getLocalModels().mode(), 'local', 'an explicitly saved local choice still overrides startup defaults')
})

test('failed model inventory is reported to the explicit reader without unhandled notification rejections', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-notification-')))
  const models = path.join(localAiDirectories(root).store, 'models')
  await fs.mkdir(path.dirname(models), { recursive: true })
  await fs.writeFile(models, 'obstruction')
  const warnings: unknown[] = [], events: unknown[] = []
  const exports = {} as typeof import('./desktopLocalModels')
  runInNewContext(code, { exports, process,
    console: { warn: (message: unknown) => warnings.push(message) },
    require(name: string): unknown {
      if (name === 'electron') return { app: { getPath: () => root, getAppPath: () => root, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }
      if (name === '../../ipc/appContractAdapter') return { appEventAdapter: { send: (...args: unknown[]) => events.push(args) } }
      return requireDependency(name)
    }
  }, { filename: 'desktopLocalModels.ts' })
  t.after(async () => { await exports.closeLocalModels(); await fs.rm(root, { recursive: true, force: true }) })
  const manager = exports.getLocalModels()
  await assert.rejects(manager.snapshot(), /ENOTDIR|模型|目录/)
  await delay(20)
  assert.deepEqual(events, [], 'do not replace the renderer snapshot with invalid data')
  assert.equal(warnings.length, 1, 'coalesce the repeated initial notifications')
})
