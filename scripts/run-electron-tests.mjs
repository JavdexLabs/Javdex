import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

function discoverTests(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (['node_modules', 'out', 'dist', 'coverage', '.git'].includes(entry.name)) return []
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'server' && path.basename(root) === 'apps') return []
        return discoverTests(fullPath)
      }
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
    '--import',
    './scripts/register-library-test-host.ts',
    '--test',
    '--test-concurrency=4'
  ]
  // Match release CI for the complete suite; keep focused runs bounded.
  const defaultTimeoutMs = requestedFiles.length > 0 ? 180_000 : 900_000
  const timeoutMs = Number(process.env.JAVDEX_TEST_TIMEOUT_MS ?? defaultTimeoutMs)

  // CreateProcess on Windows limits the entire quoted command line to 32K.
  // Keep every discovered test, with the same concurrency and total time budget.
  const commandBudget = process.platform === 'win32' ? 24_000 : Infinity
  const baseLength = [electronPath, ...args].reduce((length, value) => length + value.length + 3, 0)
  const batches = [[]]
  let commandLength = baseLength
  for (const file of testFiles) {
    if (commandLength + file.length + 3 > commandBudget && batches.at(-1).length) {
      batches.push([])
      commandLength = baseLength
    }
    batches.at(-1).push(file)
    commandLength += file.length + 3
  }
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs)
  for (const [index, batch] of batches.entries()) {
    if (Date.now() >= deadline) {
      console.error('Electron test runner exceeded its total time budget')
      process.exitCode = 1
      break
    }
    if (batches.length > 1) console.log(`Electron test batch ${index + 1}/${batches.length} (${batch.length} files)`)
    const result = spawnSync(electronPath, [...args, ...batch], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      timeout: Math.max(1, deadline - Date.now()),
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
    if (process.exitCode !== 0) break
  }
}
