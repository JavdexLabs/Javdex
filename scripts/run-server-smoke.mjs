import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
const script = target === 'node'
  ? 'server-smoke-node.mjs'
  : target === 'migration'
    ? 'server-migration-smoke.mjs'
    : null
if (!script) {
  console.error('Expected node or migration smoke target')
  process.exit(1)
}

const result = spawnSync(process.execPath, [
  '--require', './scripts/register-test-paths.cjs',
  '--import', 'tsx', `scripts/${script}`
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.server.json', ELECTRON_RUN_AS_NODE: '' }
})
if (result.error) console.error(result.error)
process.exit(result.status ?? 1)
