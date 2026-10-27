// Real Electron history + actual renderer panel; no personal catalog or media.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import electron from 'electron'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-navigation-'))
const native = process.argv.includes('--native')
if (native) assert.equal(process.platform, 'win32', '--native covers Win32 messages only')
await build({ entryPoints: ['scripts/ui-regression/playback-history.jsx'], bundle: true, format: 'esm',
  outfile: path.join(directory, 'fixture.js'), tsconfig: 'tsconfig.web.json',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl' } })
await build({ entryPoints: ['apps/desktop/src/main/desktop/windowNavigation.ts'], bundle: true,
  platform: 'node', format: 'cjs', outfile: path.join(directory, 'navigation.cjs') })
fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const platform = process.argv.includes('--x11') ? 'x11' : process.argv.includes('--wayland') ? 'wayland' : null
const child = spawn(electron, ['scripts/playback-navigation-host.cjs', directory, ...(native ? ['--native'] : []),
  ...(platform ? [`--ozone-platform=${platform}`] : []), ...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [])], { env, stdio: 'inherit', windowsHide: true })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 90000)
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) }).finally(() => clearTimeout(timer))
process.exitCode = code ?? 1
console.log(`Playback navigation evidence: ${directory}`)
