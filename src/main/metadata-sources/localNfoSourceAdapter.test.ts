import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import { assertMediaLibraryRootFile } from '../services/mediaLibraryRootFileGuard'
import { createNfoFileStore } from '../nfo/nfoFileStore'
import {
  LocalNfoSourceAdapter,
  type LocalNfoAnchor
} from './localNfoSourceAdapter'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function makeRoot(): { directory: string; root: MediaLibraryRoot } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-local-nfo-'))
  temporaryDirectories.push(directory)
  const realPath = fs.realpathSync.native(directory)
  const stat = fs.statSync(realPath)
  return {
    directory,
    root: {
      id: 1,
      libraryId: 1,
      path: directory,
      normalizedPath: normalizeLocalPathIdentity(directory),
      realPath,
      normalizedRealPath: normalizeLocalPathIdentity(realPath),
      deviceId: String(stat.dev),
      inode: String(stat.ino),
      position: 0,
      state: 'active',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z'
    }
  }
}

function write(filePath: string, content: string | Buffer = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function anchor(root: MediaLibraryRoot, anchorPath: string): LocalNfoAnchor {
  return { root, anchorPath, directoryVideoCodes: ['ABC-001'] }
}

describe('LocalNfoSourceAdapter', () => {
  it('collects one candidate per physical NFO with local asset capabilities and no paths', async () => {
    const { directory, root } = makeRoot()
    const firstVideo = path.join(directory, 'ABC-001.mp4')
    const secondVideo = path.join(directory, 'ABC-001-CD2.mp4')
    write(firstVideo)
    write(secondVideo)
    write(
      path.join(directory, 'shared.nfo'),
      `<movie><num>ABC-001</num><title>Local title</title><plot>Summary</plot>
       <thumb aspect="poster">poster.jpg</thumb>
       <fanart><thumb>https://example.test/remote.jpg</thumb></fanart>
       <actor><name>Alice</name><thumb>.actors/Alice.jpg</thumb></actor>
       <actor><name>Bob</name></actor></movie>`
    )
    fs.linkSync(path.join(directory, 'shared.nfo'), path.join(directory, 'ABC-001.nfo'))
    fs.linkSync(path.join(directory, 'shared.nfo'), path.join(directory, 'ABC-001-CD2.nfo'))
    write(path.join(directory, 'poster.jpg'), 'poster')
    write(path.join(directory, 'ABC-001-fanart.png'), 'fanart')
    write(path.join(directory, 'extrafanart', 'image10.jpg'), 'sample-10')
    write(path.join(directory, 'extrafanart', 'image2.jpg'), 'sample-2')
    write(path.join(directory, '.actors', 'Alice.jpg'), 'alice')
    write(path.join(directory, '.actors', 'Bob.jpg'), 'bob')
    const fileStore = createNfoFileStore({ authorize: assertMediaLibraryRootFile })
    const source = new LocalNfoSourceAdapter({
      listAnchors: () => [anchor(root, firstVideo), anchor(root, secondVideo)],
      fileStore,
      findExistingActorGender: (name) => (name === 'Bob' ? 'male' : null)
    })

    const collected = await source.collect({
      target: { kind: 'video', videoId: 1, code: 'ABC-001' },
      fields: ['title', 'summary', 'cover', 'samples', 'actressesFemale', 'actressesMale']
    })

    assert.equal(source.descriptor.id, 'local-nfo')
    assert.equal(source.descriptor.name, '本地 NFO（内置）')
    assert.equal(collected.candidates.length, 1)
    const candidate = collected.candidates[0]
    assert.equal(candidate.result.title, 'Local title')
    assert.deepEqual(candidate.result.actresses, [
      { name: 'Alice', gender: 'female' },
      { name: 'Bob', gender: 'male' }
    ])
    assert.deepEqual(
      candidate.assets.map((asset) => [
        asset.kind,
        asset.field,
        asset.position,
        asset.kind === 'managed-root-file' ? asset.filename : null
      ]),
      [
        ['managed-root-file', 'cover', 0, 'poster.jpg'],
        ['managed-root-file', 'samples', 0, 'ABC-001-fanart.png'],
        ['managed-root-file', 'samples', 1, 'image2.jpg'],
        ['managed-root-file', 'samples', 2, 'image10.jpg'],
        ['managed-root-file', 'actressAvatar', 0, 'Alice.jpg'],
        ['managed-root-file', 'actressAvatar', 1, 'Bob.jpg']
      ]
    )
    assert.equal(collected.warnings.some((warning) => warning.includes('远程图片')), true)
    assert.equal(JSON.stringify(collected).includes(directory), false)
    assert.equal(JSON.stringify(collected).includes('example.test'), false)
  })

  it('uses explicit gender, then existing actor gender, then dialect default', async () => {
    const { directory, root } = makeRoot()
    const video = path.join(directory, 'ABC-001.mp4')
    write(video)
    write(
      path.join(directory, 'ABC-001.nfo'),
      `<movie><num>ABC-001</num>
        <actor><name>Explicit</name><gender>male</gender></actor>
        <actor><name>Existing</name></actor><actor><name>Default</name></actor></movie>`
    )
    const source = new LocalNfoSourceAdapter({
      listAnchors: () => [anchor(root, video)],
      fileStore: createNfoFileStore({ authorize: assertMediaLibraryRootFile }),
      findExistingActorGender: (name) => (name === 'Existing' ? 'male' : null)
    })

    const collected = await source.collect({
      target: { kind: 'video', videoId: 1, code: 'ABC-001' },
      fields: ['actressesFemale', 'actressesMale']
    })
    assert.deepEqual(collected.candidates[0].result.actresses, [
      { name: 'Explicit', gender: 'male' },
      { name: 'Existing', gender: 'male' },
      { name: 'Default', gender: 'female' }
    ])
    assert.equal(collected.warnings.some((warning) => warning.includes('性别')), false)
  })

  it('keeps actress avatar positions aligned after gender field projection', async () => {
    const { directory, root } = makeRoot()
    const video = path.join(directory, 'ABC-001.mp4')
    write(video)
    write(
      path.join(directory, 'ABC-001.nfo'),
      `<movie><num>ABC-001</num>
        <actor><name>Alice</name><gender>female</gender><thumb>.actors/Alice.jpg</thumb></actor>
        <actor><name>Bob</name><gender>male</gender><thumb>.actors/Bob.jpg</thumb></actor></movie>`
    )
    write(path.join(directory, '.actors', 'Alice.jpg'), 'alice')
    write(path.join(directory, '.actors', 'Bob.jpg'), 'bob')
    const source = new LocalNfoSourceAdapter({
      listAnchors: () => [anchor(root, video)],
      fileStore: createNfoFileStore({ authorize: assertMediaLibraryRootFile }),
      findExistingActorGender: () => null
    })

    const collected = await source.collect({
      target: { kind: 'video', videoId: 1, code: 'ABC-001' },
      fields: ['actressesMale']
    })

    assert.deepEqual(collected.candidates[0].result.actresses, [
      { name: 'Bob', gender: 'male' }
    ])
    assert.deepEqual(
      collected.candidates[0].assets.map((asset) => [
        asset.field,
        asset.position,
        asset.kind === 'managed-root-file' ? asset.filename : null
      ]),
      [['actressAvatar', 0, 'Bob.jpg']]
    )
  })

  it('treats no sidecar as a quiet no-match and excludes mismatched NFO identity', async () => {
    const { directory, root } = makeRoot()
    const video = path.join(directory, 'ABC-001.mp4')
    write(video)
    const fileStore = createNfoFileStore({ authorize: assertMediaLibraryRootFile })
    const source = new LocalNfoSourceAdapter({
      listAnchors: () => [anchor(root, video)],
      fileStore,
      findExistingActorGender: () => null
    })
    assert.deepEqual(
      await source.collect({
        target: { kind: 'video', videoId: 1, code: 'ABC-001' },
        fields: ['title']
      }),
      { candidates: [], warnings: [] }
    )

    write(path.join(directory, 'ABC-001.nfo'), '<movie><num>OTHER-002</num><title>Wrong</title></movie>')
    const mismatched = await source.collect({
      target: { kind: 'video', videoId: 1, code: 'ABC-001' },
      fields: ['title']
    })
    assert.equal(mismatched.candidates.length, 0)
    assert.deepEqual(mismatched.warnings, ['NFO 番号与目标影片不一致，已跳过'])
  })
})
