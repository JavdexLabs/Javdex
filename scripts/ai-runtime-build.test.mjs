import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import buildConfig from '../electron-builder.config.mjs'
import { aiRuntimeSources, macAiBuildCommands, refreshAiBundleInventory, verifyAiBundle, stagePackagedAiRuntime,
  signPackagedAiTools, verifySignedAiRuntime, preparePackagedAiRuntime } from './ai-runtime-build.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-bundle-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'out/ai-runtime/darwin-arm64')
  for (const [id, names] of Object.entries({ whisper: ['whisper-cli', 'LICENSE'], ffmpeg: ['ffmpeg', 'ffprobe', 'COPYING.LGPLv2.1', 'SOURCE.txt'] })) {
    await fs.mkdir(path.join(directory, id), { recursive: true })
    for (const name of names) await fs.writeFile(path.join(directory, id, name), `fixture ${name}`, { mode: 0o755 })
  }
  await refreshAiBundleInventory(directory, 'arm64')
  const resources = path.join(root, 'Javdex.app/Contents/Resources')
  const context = { electronPlatformName: 'darwin', arch: 3, appOutDir: path.join(root, 'Javdex.app'),
    packager: { projectDir: root, getResourcesDir: () => resources } }
  return { root, directory, resources, context }
}
test('macOS recipes pin static, relocatable tools and select each target architecture', () => {
  assert.match(aiRuntimeSources.whisper.url, /\/[a-f0-9]{40}$/)
  for (const source of [aiRuntimeSources.whisper, aiRuntimeSources.ffmpeg]) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.ok(source.bytes > 0)
  }
  for (const arch of ['arm64', 'x64']) {
    const commands = macAiBuildCommands(arch, '/build')
    assert.ok(commands[0][1].includes(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`))
    assert.ok(commands[0][1].includes('-DBUILD_SHARED_LIBS=OFF'))
    assert.ok(commands[2][1].includes('--disable-autodetect'))
    assert.ok(commands[2][1].includes('--disable-gpl'))
    assert.ok(commands[2][1].includes('--disable-nonfree'))
  }
  assert.throws(() => macAiBuildCommands('universal', '/build'))
})
test('bundle validation rejects wrong targets, mutated files and missing mandatory tools', async t => {
  const f = await fixture(t)
  await verifyAiBundle(f.directory, 'arm64', true)
  await assert.rejects(verifyAiBundle(f.directory, 'x64'))
  await fs.appendFile(path.join(f.directory, 'whisper/whisper-cli'), 'bad')
  await assert.rejects(verifyAiBundle(f.directory, 'arm64'))
  await fs.rm(path.join(f.directory, 'ffmpeg/ffprobe'))
  await assert.rejects(refreshAiBundleInventory(f.directory, 'arm64'))
})
test('packaging stages tools outside asar, signs them before sealing the app and verifies without modifying resources', async t => {
  const f = await fixture(t)
  await stagePackagedAiRuntime(f.context)
  const staged = path.join(f.resources, 'ai-runtime/darwin-arm64')
  const before = await fs.readFile(path.join(staged, 'bundle.json'), 'utf8'), signed = []
  const ignore = await signPackagedAiTools(path.join(f.root, 'Javdex.app'), '-', '/entitlements.plist', async (command, args) => {
    assert.equal(command, 'codesign'); assert.ok(args.includes('--timestamp=none'))
    const filename = args.at(-1); signed.push(filename)
    await fs.appendFile(filename, 'signed bytes')
  })
  assert.equal(signed.length, 3)
  for (const filename of signed) assert.equal(ignore(filename), true)
  assert.equal(ignore(path.join(f.root, 'Javdex.app/Contents/MacOS/Javdex')), false)
  assert.notEqual(await fs.readFile(path.join(staged, 'bundle.json'), 'utf8'), before)
  const final = await fs.readFile(path.join(staged, 'bundle.json'), 'utf8')
  await verifySignedAiRuntime(f.context)
  assert.equal(await fs.readFile(path.join(staged, 'bundle.json'), 'utf8'), final)
  const source = JSON.parse(await fs.readFile(path.join(f.directory, 'bundle.json'), 'utf8'))
  assert.notEqual(JSON.parse(final).assets.whisper.files.find(entry => entry.name === 'whisper-cli').sha256,
    source.assets.whisper.files.find(entry => entry.name === 'whisper-cli').sha256)
})
test('non-Mac packages do not build/stage tools and all packages exclude AI build and acceptance files', async () => {
  await preparePackagedAiRuntime({ electronPlatformName: 'linux' })
  await stagePackagedAiRuntime({ electronPlatformName: 'win32' })
  await verifySignedAiRuntime({ electronPlatformName: 'linux' })
  const root = process.cwd(), config = buildConfig()
  assert.equal(typeof config.afterSign, 'function')
  for (const patterns of [config.files, config.win.files]) {
    const filter = new FileMatcher(root, '/package', value => value, patterns).createFilter()
    for (const file of ['out/ai-runtime/darwin-arm64/whisper/whisper-cli', 'out/ai-runtime-build/sources/whisper.tar.gz', 'out/ai-runtime-acceptance/runtime/models.bin']) {
      assert.equal(filter(path.join(root, file), { isDirectory: () => false }), false)
    }
    assert.equal(filter(path.join(root, 'out/main/index.js'), { isDirectory: () => false }), true)
  }
})
test('real ad-hoc app signing preserves signed AI CLI hashes and the outer resource seal', { skip: process.platform !== 'darwin' ? 'codesign requires macOS' : false }, async t => {
  const f = await fixture(t), app = path.join(f.root, 'Javdex.app')
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true })
  const source = path.join(f.root, 'stub.c'), binary = path.join(app, 'Contents/MacOS/Javdex')
  await fs.writeFile(source, 'int main(void) { return 0; }\n')
  const compiled = spawnSync('clang', [source, '-o', binary], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  for (const [id, names] of Object.entries({ whisper: ['whisper-cli'], ffmpeg: ['ffmpeg', 'ffprobe'] })) {
    for (const name of names) await fs.copyFile(binary, path.join(f.directory, id, name))
  }
  await refreshAiBundleInventory(f.directory, 'arm64')
  await stagePackagedAiRuntime(f.context)
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Javdex</string><key>CFBundleIdentifier</key><string>com.javdex.ai-signing-test</string><key>CFBundleName</key><string>Javdex</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.0</string></dict></plist>`)
  await buildConfig().mac.sign({ app, platform: 'darwin', identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false })
  await verifySignedAiRuntime(f.context)
  const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
})
