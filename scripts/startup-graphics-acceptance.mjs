import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import electron from 'electron'
import ts from 'typescript'

const root = path.resolve('out', 'startup-graphics-acceptance-' + new Date().toISOString().replaceAll(/[:.]/g, '-'))
mkdirSync(root, { recursive: true })
const source = path.resolve('apps/desktop/src/main/bootstrap')
const results = []
for (const scenario of ['normal', 'pre-ready', 'recover', 'double-failure', 'user-retry', 'manual-software', 'non-graphics']) {
  const directory = path.join(root, scenario)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), '{"type":"commonjs"}\n')
  for (const file of ['startupGraphics.ts', 'startupGraphicsRecovery.ts']) {
    writeFileSync(path.join(directory, file.replace('.ts', '.js')), ts.transpileModule(readFileSync(path.join(source, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText)
  }
  const entry = path.join(directory, 'entry.cjs')
  writeFileSync(entry, readFileSync('scripts/fixtures/startup-graphics-entry.cjs', 'utf8'))
  const env = { ...process.env, JAVDEX_STARTUP_ACCEPTANCE_ROOT: directory, JAVDEX_STARTUP_ACCEPTANCE_SCENARIO: scenario }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [entry, '--user-data-dir=' + path.join(directory, 'profile'), ...(scenario === 'manual-software' ? ['--javdex-software'] : [])]
  const child = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  child.on('error', error => { output += error.message })
  const expectedEntries = scenario === 'user-retry' ? 3 : ['pre-ready', 'recover', 'double-failure'].includes(scenario) ? 2 : 1
  let events = []
  const deadline = Date.now() + 25000
  for (;;) {
    try { events = readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { /* Child has not written its first record yet. */ }
    if (events.filter(v => v.event === 'entry').length >= expectedEntries && events.filter(v => v.event === 'quit').length >= expectedEntries) break
    assert.ok(Date.now() < deadline, `${scenario}: startup acceptance timed out in ${directory}\n${output.slice(-2000)}`)
    await delay(100)
  }
  writeFileSync(path.join(directory, 'console.log'), output)
  const entries = events.filter(v => v.event === 'entry'), windows = events.filter(v => v.event === 'window-ready')
  const errors = events.filter(v => v.event === 'error-dialog'), notices = events.filter(v => v.event === 'recovered-dialog')
  assert.equal(entries.length, expectedEntries, scenario + ': relaunch count')
  assert.equal(new Set(entries.map(v => v.pid)).size, expectedEntries, scenario + ': actual distinct processes')
  assert.equal(events.some(v => ['timeout', 'harness-error'].includes(v.event)), false)
  assert.equal(errors.length, ['double-failure', 'non-graphics'].includes(scenario) ? 1 : 0)
  assert.equal(notices.length, ['pre-ready', 'recover', 'user-retry'].includes(scenario) ? 1 : 0)
  assert.equal(windows.length, ['double-failure', 'non-graphics'].includes(scenario) ? 0 : scenario === 'user-retry' ? 2 : 1)
  for (const window of windows) assert.deepEqual(window.pixels, [10, 20, 30, 255])
  if (['pre-ready', 'recover', 'manual-software'].includes(scenario)) assert.equal(windows[0].accelerated, false)
  if (scenario === 'normal') assert.equal(windows[0].accelerated, true)
  if (scenario === 'user-retry') {
    assert.equal(windows[0].accelerated, false); assert.equal(windows[1].accelerated, true)
    assert.ok(!entries[2].args.includes('--javdex-software'))
  }
  const logs = readFileSync(path.join(directory, 'profile/logs/startup.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(logs.filter(v => v.code === 'SOFTWARE_RELAUNCH').length, expectedEntries > 1 ? 1 : 0)
  assert.equal(logs.some(v => 'args' in v), false)
  results.push({ scenario, processes: entries.length, windows: windows.length, errors: errors.length, notices: notices.length, passed: true })
  console.log('PASS', scenario)
}
writeFileSync(path.join(root, 'results.json'), JSON.stringify({ platform: process.platform, electron: (await import('electron/package.json', { with: { type: 'json' } })).default.version, results }, null, 2) + '\n')
console.log(root)
