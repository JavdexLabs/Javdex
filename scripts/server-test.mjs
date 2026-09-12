import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
if (path.basename(node) !== 'node') {
  console.error(`server:test must use Node, not ${node}`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

function run(args) {
  const result = spawnSync(node, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TSX_TSCONFIG_PATH: 'tsconfig.server.json' }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run([tsc, '--noEmit', '-p', 'tsconfig.server.json'])
run([
  '--require',
  './scripts/register-test-paths.cjs',
  '--import',
  'tsx',
  '--test',
  'apps/server/src/config.test.ts',
  'apps/server/src/identity.test.ts',
  'apps/server/src/filesystem.test.ts',
  'apps/server/src/imageCodec.test.ts',
  'apps/server/src/catalogGate.test.ts',
  'apps/server/src/runtime.test.ts'
])
