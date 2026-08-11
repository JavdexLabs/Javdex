import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

function discoverTests(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) return discoverTests(fullPath)
      return /\.test\.tsx?$/.test(entry.name) ? [fullPath.replaceAll('\\', '/')] : []
    })
    .sort()
}

const requestedFiles = process.argv.slice(2)
const testFiles = requestedFiles.length > 0 ? requestedFiles : discoverTests('src')
if (testFiles.length === 0) {
  console.error('No test files found under src/**/*.test.ts(x)')
  process.exit(1)
}
const args = [
  '--require',
  './scripts/register-test-paths.cjs',
  '--import',
  './scripts/register-test-styles.mjs',
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
