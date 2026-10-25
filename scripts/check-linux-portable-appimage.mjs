#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { validatePortableRuntime } from './linux-portable-runtime.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'
const require = createRequire(import.meta.url)
const image = path.resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'Pass the actual AppImage')
const work = mkdtempSync(path.join(tmpdir(), 'javdex-portable-appimage-'))
const result = spawnSync(image, ['--appimage-extract'], { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
assert.equal(result.status, 0, result.stderr)
const app = path.join(work, 'squashfs-root')
const manifest = validatePortableRuntime(path.join(app, 'resources/linux-texture-experimental'))
assert.equal(readFileSync(path.join(app, 'AppRun'), 'utf8'), readFileSync('build/linux-portable-AppRun.sh', 'utf8'))
const metadata = JSON.parse(require('@electron/asar').extractFile(path.join(app, 'resources/app.asar'), 'package.json'))
assert.equal(metadata.javdexExperimentalLinux, true)
assert.equal(metadata.name, 'javdex-linux-portable-phase1')
const desktop = readFileSync(path.join(app, 'javdex-linux-portable-phase1.desktop'), 'utf8')
assert.ok(!/--no-sandbox/.test(desktop), 'Sandbox-disabling desktop entry')
const source = path.resolve('out/linux-portable-runtime', manifest.sourceBundle.filename)
assert.equal(playbackFileSha256(source), manifest.sourceBundle.sha256)
console.log(JSON.stringify({ image, sha256: playbackFileSha256(image), extracted: app, profile: manifest.profile, elfFiles: Object.keys(manifest.elf).length, sourceBundle: source }, null, 2))
