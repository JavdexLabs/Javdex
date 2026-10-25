import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import buildConfig from '../electron-builder.config.mjs'
import { verifyNoPackagedAiRuntime } from './packaging-runtime.mjs'

test('all packages exclude stale AI bundles, build sources and acceptance artifacts', () => {
  const root = process.cwd(), config = buildConfig()
  for (const patterns of [config.files, config.win.files]) {
    const filter = new FileMatcher(root, '/package', value => value, patterns).createFilter()
    for (const file of ['out/ai-runtime/darwin-arm64/whisper/whisper-cli', 'out/ai-runtime-build/sources/whisper.tar.gz', 'out/ai-runtime-acceptance/runtime/models.bin']) {
      assert.equal(filter(path.join(root, file), { isDirectory: () => false }), false)
    }
    assert.equal(filter(path.join(root, 'out/main/index.js'), { isDirectory: () => false }), true)
  }
})
test('real ad-hoc app signing preserves the outer seal without bundled AI tools', { skip: process.platform !== 'darwin' ? 'codesign requires macOS' : false }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-sign-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const app = path.join(root, 'Javdex.app')
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true })
  const source = path.join(root, 'stub.c'), binary = path.join(app, 'Contents/MacOS/Javdex')
  await fs.writeFile(source, 'int main(void) { return 0; }\n')
  const compiled = spawnSync('clang', [source, '-o', binary], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Javdex</string><key>CFBundleIdentifier</key><string>com.javdex.ai-signing-test</string><key>CFBundleName</key><string>Javdex</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.0</string></dict></plist>`)
  await buildConfig().mac.sign({ app, platform: 'darwin', identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false })
  const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
})

test('packaging rejects a stale AI resources directory without deleting existing artifacts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-no-bundled-ai-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const context = { appOutDir: root, packager: { getResourcesDir: () => root } }
  verifyNoPackagedAiRuntime(context)
  const file = path.join(root, 'ai-runtime/darwin-arm64/whisper/whisper-cli')
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'old tool')
  assert.throws(() => verifyNoPackagedAiRuntime(context), /downloaded on demand/)
  assert.equal(await fs.readFile(file, 'utf8'), 'old tool')
})
