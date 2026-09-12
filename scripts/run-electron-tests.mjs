import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

function discoverTests(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (['node_modules', 'out', 'dist', 'coverage', '.git'].includes(entry.name)) return []
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) return discoverTests(fullPath)
      return /\.test\.tsx?$/.test(entry.name) ? [fullPath.replaceAll('\\', '/')] : []
    })
    .sort()
}

const requestedFiles = process.argv.slice(2)
const testFiles = requestedFiles.length > 0 ? requestedFiles : ['apps', 'packages'].flatMap(discoverTests).sort()
if (testFiles.length === 0) {
  console.error('No test files found under apps/ or packages/')
  process.exitCode = 1
} else {
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
  const timeoutMs = Number(process.env.JAVDEX_TEST_TIMEOUT_MS ?? 180_000)

  const result = spawnSync(electronPath, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    shell: false,
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
    killSignal: 'SIGTERM'
  })

  if (result.error) {
    const timeoutHint = result.error.code === 'ETIMEDOUT'
      ? ` after ${timeoutMs} ms; inspect leaked handles or increase JAVDEX_TEST_TIMEOUT_MS`
      : ''
    console.error(`Electron test runner failed${timeoutHint}: ${result.error.message}`)
  }
  if (result.signal) console.error(`Electron test process exited via signal ${result.signal}`)
  process.exitCode = result.status ?? 1
}
