import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LOCAL_MODEL_ASSETS } from './runtimeManifest'
import { canonicalStoragePath, cleanModelTemporaryFiles, ensureModelStore, ensureStorageDirectory,
  localAiDirectories, modelAssetDirectory, modelDownloadDirectory, runtimeAssetDirectory } from './modelStorage'

test('storage uses model identities and versioned platform runtimes independent of purposes', () => {
  const root = path.resolve('store'), asset = LOCAL_MODEL_ASSETS.find(asset => asset.id === 'translation-model')!
  assert.equal(path.relative(root, modelAssetDirectory(root, asset)), path.join('models', 'qwen3-1.7b', 'bartowski', asset.model!.revision, 'Q4_K_M'))
  assert.equal(path.relative(root, runtimeAssetDirectory(root, 'translator', { platform: 'win32', arch: 'x64' })), path.join('runtimes', 'llama.cpp', 'b11435', 'win32-x64-cpu'))
  assert.notEqual(runtimeAssetDirectory(root, 'translator', { platform: 'win32', arch: 'x64' }), runtimeAssetDirectory(root, 'translator', { platform: 'darwin', arch: 'arm64' }))
  const roaming = path.resolve('profile/roaming'), local = path.resolve('profile/local')
  const env = { APPDATA: roaming, LOCALAPPDATA: local }
  assert.equal(localAiDirectories(path.join(roaming, 'Javdex'), 'win32', env).store, path.join(local, 'Javdex', 'local-ai'))
  assert.equal(localAiDirectories(path.resolve('test-profile'), 'win32', env).store, path.resolve('test-profile/local-ai'))
})

test('temporary expiry and manual download cleanup preserve weights and unrelated files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-storage-'))
  try {
    await ensureModelStore(root)
    const weight = modelAssetDirectory(root, LOCAL_MODEL_ASSETS.find(asset => asset.id === 'kotoba')!)
    await ensureStorageDirectory(root, weight); await fs.writeFile(path.join(weight, 'weight.bin'), 'keep')
    const expired = modelDownloadDirectory(root, LOCAL_MODEL_ASSETS.find(asset => asset.id === 'kotoba')!), recent = modelDownloadDirectory(root, LOCAL_MODEL_ASSETS.find(asset => asset.id === 'translation-model')!)
    const staging = path.join(root, 'staging', 'import-12345678-1234-1234-1234-123456789abc')
    for (const dir of [expired, recent, staging, path.join(root, 'downloads', 'unrelated')]) {
      await ensureStorageDirectory(root, dir); await fs.writeFile(path.join(dir, 'part'), 'data')
    }
    const now = Date.now(), old = new Date(now - 8 * 86400000)
    await fs.utimes(expired, old, old); await fs.utimes(staging, old, old)
    await cleanModelTemporaryFiles(root, false, now)
    for (const dir of [expired, staging]) await assert.rejects(fs.access(dir))
    await fs.access(recent)
    await cleanModelTemporaryFiles(root, true)
    await assert.rejects(fs.access(recent))
    assert.equal(await fs.readFile(path.join(weight, 'weight.bin'), 'utf8'), 'keep')
    await fs.access(path.join(root, 'downloads', 'unrelated', 'part'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('managed paths reject junctions, and resolving a relocation target does not create it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-storage-'))
  try {
    const outside = path.join(root, 'outside'), store = path.join(root, 'store')
    await fs.mkdir(outside); await ensureModelStore(store)
    await fs.writeFile(path.join(outside, 'keep'), 'safe')
    await fs.symlink(outside, path.join(store, 'models'), 'junction')
    await assert.rejects(ensureStorageDirectory(store, path.join(store, 'models', 'child')), /链接/)
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'safe')
    const absent = path.join(store, 'nested', 'destination')
    assert.equal(await canonicalStoragePath(absent), path.join(await fs.realpath(store), 'nested', 'destination'))
    await assert.rejects(fs.access(path.dirname(absent)))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
