import { spawnSync } from 'node:child_process'
import electronPath from 'electron'

const testFiles = process.argv.slice(2)
const args = [
  '--require',
  './scripts/register-test-paths.cjs',
  '--import',
  'tsx',
  '--test',
  ...testFiles
]

const result = spawnSync(electronPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  },
  shell: false
})

process.exit(result.status ?? 1)
