import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./check-workspaces.mjs', import.meta.url))
const directories = ['apps/desktop', 'apps/web', 'apps/server', 'packages/contracts', 'packages/ui', 'packages/library', 'packages/http']

test('workspace check rejects stale internal dependency pins and stale lock entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-workspace-check-'))
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value))
  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
  try {
    const version = '0.8.0-beta.2'
    const lock = { version, packages: { '': { version } } }
    write('package.json', { version, scripts: {} })
    for (const directory of directories) {
      fs.mkdirSync(path.join(root, directory, 'src'), { recursive: true })
      const manifest = { name: `@javdex/${path.basename(directory)}`, version, private: true }
      write(`${directory}/package.json`, manifest)
      lock.packages[directory] = { ...manifest }
    }
    const desktop = { ...lock.packages['apps/desktop'], dependencies: { '@javdex/contracts': version } }
    write('apps/desktop/package.json', desktop)
    lock.packages['apps/desktop'] = structuredClone(desktop)
    write('package-lock.json', lock)
    assert.equal(run().status, 0)

    desktop.dependencies['@javdex/contracts'] = '0.8.0-beta.1'
    write('apps/desktop/package.json', desktop)
    const stalePin = run()
    assert.notEqual(stalePin.status, 0)
    assert.match(stalePin.stderr, /contracts must use the current product version/)

    desktop.dependencies['@javdex/contracts'] = version
    write('apps/desktop/package.json', desktop)
    lock.packages['apps/desktop'].dependencies['@javdex/contracts'] = '0.8.0-beta.1'
    write('package-lock.json', lock)
    const staleLock = run()
    assert.notEqual(staleLock.status, 0)
    assert.match(staleLock.stderr, /locked @javdex\/contracts must match/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
