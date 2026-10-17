import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { writeSubtitleFile } from './writeSubtitleFile'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ass-lock-'))
  const filename = path.join(root, 'AI 日中字幕.ass')
  await fs.writeFile(filename, 'previous complete document')
  return { root, filename, signal: new AbortController().signal }
}

test('Windows subtitle writes recover from reader locks without exposing a partial document', { skip: process.platform !== 'win32' }, async t => {
  const { root, filename, signal } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const rename = fs.rename
  let attempts = 0
  t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (++attempts <= 2) {
      assert.equal(await fs.readFile(filename, 'utf8'), 'previous complete document')
      throw Object.assign(new Error('reader holds the destination'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' })
    }
    await rename(from, to)
  })
  await writeSubtitleFile(filename, 'latest complete document', signal)
  assert.equal(attempts, 3)
  assert.equal(await fs.readFile(filename, 'utf8'), 'latest complete document')
  assert.deepEqual(await fs.readdir(root), [path.basename(filename)], 'failed attempts must clean their temporary files')
})

test('permanent subtitle permission failures remain bounded and preserve the previous document', { skip: process.platform !== 'win32' }, async t => {
  const { root, filename, signal } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let attempts = 0
  t.mock.method(fs, 'rename', async () => {
    attempts++
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  })
  await assert.rejects(writeSubtitleFile(filename, 'replacement', signal), { code: 'EACCES' })
  assert.equal(attempts, 6)
  assert.equal(await fs.readFile(filename, 'utf8'), 'previous complete document')
  assert.deepEqual(await fs.readdir(root), [path.basename(filename)])
})

test('stopping a subtitle session cancels reader-lock retries', { skip: process.platform !== 'win32' }, async t => {
  const { root, filename } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const controller = new AbortController()
  let attempts = 0
  t.mock.method(fs, 'rename', async () => {
    attempts++
    controller.abort()
    throw Object.assign(new Error('reader lock'), { code: 'EPERM' })
  })
  await assert.rejects(writeSubtitleFile(filename, 'replacement', controller.signal), { name: 'AbortError' })
  assert.equal(attempts, 1)
  assert.equal(await fs.readFile(filename, 'utf8'), 'previous complete document')
  assert.deepEqual(await fs.readdir(root), [path.basename(filename)])
})

test('subtitle writes do not retry unrelated filesystem failures', async t => {
  const { root, filename, signal } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let attempts = 0
  t.mock.method(fs, 'rename', async () => {
    attempts++
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  })
  await assert.rejects(writeSubtitleFile(filename, 'replacement', signal), { code: 'ENOSPC' })
  assert.equal(attempts, 1)
  assert.equal(await fs.readFile(filename, 'utf8'), 'previous complete document')
})
