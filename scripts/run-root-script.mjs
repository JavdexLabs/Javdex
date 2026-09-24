import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = process.argv[2]
if (!script || !process.env.npm_execpath) throw new Error('Run this helper through an npm workspace script')
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', script, '--', ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, npm_config_workspace: '', npm_config_workspaces: 'false' },
  shell: false
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
