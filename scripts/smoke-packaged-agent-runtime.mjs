#!/usr/bin/env node

import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const archive = path.resolve(process.argv[2] ?? '')
const requireFromApp = createRequire(path.join(archive, 'package.json'))
const cheerio = requireFromApp('cheerio')
const cheerioSlim = requireFromApp('cheerio/slim')
const undici = requireFromApp('undici')

if (
  typeof cheerio.load !== 'function' ||
  typeof cheerioSlim.load !== 'function' ||
  typeof undici.fetch !== 'function'
) {
  throw new Error('Packaged Cheerio or Undici exports are invalid')
}

const chunks = readdirSync(path.join(archive, 'out/main/chunks'))
const piChunk = chunks.find(name => /^piSdk-.*\.js$/.test(name))
assert.ok(piChunk, 'Packaged Pi SDK is missing')
const piModule = requireFromApp(`./out/main/chunks/${piChunk}`)
const sdk = piModule.piSdk ?? piModule
const temporary = mkdtempSync(path.join(tmpdir(), 'javdex-packaged-pi-'))
try {
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [], skills: [],
    prompts: [], themes: [], defaultTools: [] }, { projectTrusted: false })
  const loader = new sdk.DefaultResourceLoader({ cwd: temporary, agentDir: path.join(temporary, 'agent'),
    settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    noContextFiles: true, extensionFactories: [pi => { pi.on('tool_call', () => undefined) }] })
  await loader.reload()
  assert.equal(loader.getExtensions().extensions.length, 1, 'Packaged Pi resource loader failed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

const photonChunk = chunks.find(name => /^photon_rs-.*\.js$/.test(name))
assert.ok(photonChunk, 'Packaged Photon chunk is missing')
const photon = requireFromApp(`./out/main/chunks/${photonChunk}`).photon_rs
const image = new photon.PhotonImage(new Uint8Array([12, 34, 56, 255]), 1, 1)
try {
  const png = image.get_bytes()
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Packaged Photon WASM failed PNG encoding')
} finally {
  image.free()
}

if (process.platform === 'win32') {
  const clipboard = requireFromApp('@mariozechner/clipboard')
  assert.equal(typeof clipboard.getText, 'function', 'Packaged clipboard native binding failed to load')
  const consoleMode = requireFromApp(`./node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-${process.arch}/win32-console-mode.node`)
  assert.ok(Object.keys(consoleMode).length > 0, 'Packaged Windows console native binding failed to load')
}

console.log('Packaged Node module smoke passed')
