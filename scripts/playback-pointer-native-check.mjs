// GNOME-only native click classification check. Browser/RPC fixtures stay isolated
// from the personal catalog; unavailable native input support is a failure.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import electron from 'electron'

assert.equal(process.platform, 'linux', 'This native input harness requires Linux GNOME/Mutter')
const platform = process.argv.includes('--x11') ? 'x11' : 'wayland'
execFileSync('/usr/bin/python3', ['-c', 'import dbus'], { stdio: 'inherit' })
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pointer-native-'))
await build({ entryPoints: ['scripts/ui-regression/playback-settings.jsx'], bundle: true, format: 'esm',
  outfile: path.join(directory, 'fixture.js'), tsconfig: 'tsconfig.web.json',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl' } })
await build({ entryPoints: ['apps/desktop/src/main/desktop/pointerTiming.ts'], bundle: true,
  platform: 'node', format: 'cjs', tsconfig: 'tsconfig.node.json', outfile: path.join(directory, 'pointer-timing.cjs') })
fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['scripts/playback-pointer-native-host.cjs', directory, `--ozone-platform=${platform}`,
  ...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [])], { env, stdio: 'inherit' })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 90000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }).finally(() => clearTimeout(timer))
process.exitCode = code ?? 1
console.log(`Native pointer evidence: ${directory}`)
