import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import * as policy from './startupGraphicsRecovery'

const code = transpileModule(readFileSync(new URL('./startupGraphics.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
for (const [platform, packaged, appImage] of [
  ['win32', true, false], ['darwin', true, false], ['linux', true, false], ['linux', true, true], ['linux', false, true]
] as const) test(`${platform} (packaged: ${packaged}, AppImage: ${appImage}): adapter logs, relaunches once and detaches at quit`, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'javdex-startup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const relaunches: string[][] = [], errors: string[] = []
  const image = path.join(root, 'Javdex with spaces.AppImage')
  writeFileSync(image, 'launcher fixture')
  let execPath: string | undefined
  let disabled = 0, quits = 0
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, getPath: () => root, disableHardwareAcceleration() { disabled++ },
    relaunch(options: { args: string[]; execPath?: string }) { execPath = options.execPath; relaunches.push(options.args) },
    quit() { quits++; app.emit('before-quit') }
  })
  const exports = {} as typeof import('./startupGraphics')
  runInNewContext(code, { exports, process: { argv: ['electron', '/app'], platform, pid: 1, env: appImage ? { APPIMAGE: image } : {} }, Date,
    require(id: string) {
      if (id === './startupGraphicsRecovery') return policy
      if (id === 'node:fs') return fs
      if (id === 'node:path') return path
      if (id === 'electron') return { app, dialog: { showErrorBox: (_title: string, message: string) => errors.push(message) }, shell: {} }
      throw Error(id)
    }
  })
  exports.configureStartupGraphics(); exports.startupGraphics.claimPrimary(true)
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 13 })
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 14 })
  assert.equal(disabled, 0); assert.equal(quits, 1); assert.equal(relaunches.length, 1); assert.deepEqual(errors, [])
  assert.equal(app.listenerCount('child-process-gone'), 0)
  assert.equal(execPath, platform === 'linux' && packaged && appImage ? image : undefined)
  const log = readFileSync(path.join(root, 'logs/startup.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(log.map(row => row.code), ['STARTUP', 'GPU_STARTUP_FAILED', 'SOFTWARE_RELAUNCH'])
  assert.ok(log.every(row => row.platform === platform && !('args' in row)))
})
