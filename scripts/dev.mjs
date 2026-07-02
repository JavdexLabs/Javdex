import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronViteBin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [electronViteBin, 'dev'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: false
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
