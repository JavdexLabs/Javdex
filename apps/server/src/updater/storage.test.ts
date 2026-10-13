import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { copyTree, MANAGED_LOCK, restoreTree, treeBytes, treeHash } from './storage'

test('only the data root lock is excluded; nested and image-root names remain in complete snapshots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-snapshot-tree-'))
  try {
    const data = path.join(root, 'data')
    const snapshot = path.join(root, 'snapshot')
    const nested = path.join(data, 'media_assets', MANAGED_LOCK)
    fs.mkdirSync(path.dirname(nested), { recursive: true })
    fs.writeFileSync(path.join(data, MANAGED_LOCK), 'held lock')
    fs.writeFileSync(nested, 'owned image bytes')
    const lockInode = fs.statSync(path.join(data, MANAGED_LOCK)).ino
    const options = { excludeRootLock: true }
    assert.equal(await treeBytes(data, options), Buffer.byteLength('owned image bytes'))
    await copyTree(data, snapshot, options)
    assert.equal(fs.existsSync(path.join(snapshot, MANAGED_LOCK)), false)
    assert.equal(fs.readFileSync(path.join(snapshot, 'media_assets', MANAGED_LOCK), 'utf8'), 'owned image bytes')
    assert.equal(await treeHash(data, options), await treeHash(snapshot))
    const hash = await treeHash(snapshot)
    fs.writeFileSync(path.join(snapshot, 'media_assets', MANAGED_LOCK), 'changed')
    assert.notEqual(await treeHash(snapshot), hash)
    fs.writeFileSync(path.join(snapshot, 'media_assets', MANAGED_LOCK), 'owned image bytes')
    fs.writeFileSync(nested, 'new bytes')
    await restoreTree(snapshot, data, options)
    assert.equal(fs.statSync(path.join(data, MANAGED_LOCK)).ino, lockInode)
    assert.equal(fs.readFileSync(nested, 'utf8'), 'owned image bytes')

    const images = path.join(root, 'images')
    const imageSnapshot = path.join(root, 'image-snapshot')
    fs.mkdirSync(images)
    fs.writeFileSync(path.join(images, MANAGED_LOCK), 'not a kernel lock')
    assert.equal(await treeBytes(images), Buffer.byteLength('not a kernel lock'))
    await copyTree(images, imageSnapshot)
    fs.writeFileSync(path.join(images, MANAGED_LOCK), 'changed')
    await restoreTree(imageSnapshot, images)
    assert.equal(fs.readFileSync(path.join(images, MANAGED_LOCK), 'utf8'), 'not a kernel lock')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
