import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./check-installed-overrides.mjs', import.meta.url))
test('installed security gate catches shrinkwrap reinstatement and actual dependency downgrades', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-installed-overrides-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), JSON.stringify(value))
  }
  const agent = 'node_modules/@earendil-works/pi-coding-agent'
  const undici = `${agent}/node_modules/undici/package.json`
  const brace = `${agent}/node_modules/brace-expansion/package.json`
  write('package.json', { overrides: { '@earendil-works/pi-coding-agent': {
    undici: '8.12.2', minimatch: { 'brace-expansion': '5.0.12' }
  } } })
  write(`${agent}/package.json`, { name: '@earendil-works/pi-coding-agent', exports: { './sdk': './dist/index.js' } })
  write(`${agent}/dist/index.js`, {})
  for (const [name, version] of [['minimatch', '10.2.5'], ['undici', '8.12.2'], ['brace-expansion', '5.0.12']]) {
    write(`${agent}/node_modules/${name}/package.json`, { name, version, exports: { '.': './index.js' } })
    write(`${agent}/node_modules/${name}/index.js`, {})
  }
  const lock = { packages: { [agent]: {} } }
  write('package-lock.json', lock)
  const run = () => spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
  assert.equal(run().status, 0)
  for (const [file, oldVersion, newVersion] of [[undici, '8.9.0', '8.12.2'], [brace, '5.0.9', '5.0.12']]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    write(file, { ...manifest, version: oldVersion })
    const result = run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /differs from the security override/)
    write(file, { ...manifest, version: newVersion })
  }
  lock.packages[agent].hasShrinkwrap = true
  write('package-lock.json', lock)
  assert.match(run().stderr, /Pi shrinkwrap must not override/)
  delete lock.packages[agent].hasShrinkwrap
  write('package-lock.json', lock)
  fs.rmSync(path.join(root, undici))
  assert.notEqual(run().status, 0)
})
