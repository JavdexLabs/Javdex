#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const chunksDirectory = path.resolve('out/main/chunks')
const piSdkChunks = readdirSync(chunksDirectory).filter(
  (name) => name.startsWith('piSdk-') && name.endsWith('.js')
)
assert.equal(piSdkChunks.length, 1, `Expected one built Pi SDK chunk, found ${piSdkChunks.length}`)

const require = createRequire(import.meta.url)
const builtModule = require(path.join(chunksDirectory, piSdkChunks[0]))
const sdk = builtModule.piSdk ?? builtModule
for (const name of [
  'AgentSession',
  'DefaultResourceLoader',
  'ModelRuntime',
  'SessionManager',
  'SettingsManager',
  'createAgentSession'
]) {
  assert.equal(typeof sdk[name], 'function', `Built Pi SDK is missing ${name}`)
}

const root = mkdtempSync(path.join(tmpdir(), 'javdex-built-pi-runtime-'))
try {
  const settingsManager = sdk.SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    defaultTools: []
  }, { projectTrusted: false })
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, 'agent'),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on('tool_call', () => undefined)
      }
    ]
  })
  await resourceLoader.reload()
  assert.equal(resourceLoader.getExtensions().extensions.length, 1)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`Built Pi runtime verified: ${piSdkChunks[0]}`)
