import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
assert.equal(path.basename(node), 'node', `http node-load must use Node, not ${node}`)

const result = spawnSync(
  node,
  [
    '--import',
    'tsx',
    '--require',
    './scripts/register-test-paths.cjs',
    './scripts/http-node-load-entry.ts'
  ],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  }
)
if (result.status !== 0) {
  process.stderr.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}
process.stdout.write(result.stdout)
