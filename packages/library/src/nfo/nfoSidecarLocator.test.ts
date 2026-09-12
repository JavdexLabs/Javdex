import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { normalizeLocalPathIdentity } from '@library/localPathIdentity'
import { assertMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'
import { createNfoFileStore } from './nfoFileStore'
import { locateNfoSidecar } from './nfoSidecarLocator'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function makeRoot(): { directory: string; root: MediaLibraryRoot } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-locator-'))
  temporaryDirectories.push(directory)
  const realPath = fs.realpathSync.native(directory)
  const stat = fs.statSync(realPath, { bigint: true })
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

function touch(filePath: string, content = ''): void {
  fs.writeFileSync(filePath, content)
}

describe('NFO sidecar locator', () => {
  it('prefers exact stem and reports a differing movie.nfo without exposing either path', () => {
    const { directory, root } = makeRoot()
    const video = path.join(directory, 'ABC-001.mp4')
    touch(video)
    touch(path.join(directory, 'ABC-001.nfo'), '<movie><num>ABC-001</num></movie>')
    touch(path.join(directory, 'movie.nfo'), '<movie><num>OTHER-002</num></movie>')
    const store = createNfoFileStore({ authorize: assertMediaLibraryRootFile })

    const located = locateNfoSidecar({
      anchorPath: video,
      root,
      directoryVideoCodes: ['ABC-001'],
      fileStore: store
    })

    assert.equal(located.status, 'found')
    assert.equal(located.filename, 'ABC-001.nfo')
    assert.deepEqual(located.warnings.map((warning) => warning.code), ['shadowed-movie-nfo'])
    assert.equal(JSON.stringify(located).includes(directory), false)
    assert.match(store.readText(located.capability!), /ABC-001/u)
  })

  it('uses movie.nfo only for one anchor or one logical code and rejects mixed directories', () => {
    const { directory, root } = makeRoot()
    const first = path.join(directory, 'ABC-001-CD1.mp4')
    const second = path.join(directory, 'ABC-001-CD2.mp4')
    touch(first)
    touch(second)
    touch(path.join(directory, 'movie.nfo'), '<movie><num>ABC-001</num></movie>')
    const store = createNfoFileStore({ authorize: assertMediaLibraryRootFile })

    assert.equal(
      locateNfoSidecar({
        anchorPath: first,
        root,
        directoryVideoCodes: ['ABC-001', 'ABC-001'],
        fileStore: store
      }).status,
      'found'
    )
    const mixed = locateNfoSidecar({
      anchorPath: first,
      root,
      directoryVideoCodes: ['ABC-001', 'XYZ-002'],
      fileStore: store
    })
    assert.equal(mixed.status, 'ambiguous')
    assert.deepEqual(mixed.warnings.map((warning) => warning.code), ['ambiguous-movie-nfo'])
  })

  it('deduplicates physical sidecars and rejects symlink escapes at issue and read time', () => {
    const { directory, root } = makeRoot()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-outside-'))
    temporaryDirectories.push(outside)
    touch(path.join(outside, 'outside.nfo'), '<movie/>')
    touch(path.join(directory, 'ABC-001.mp4'))
    fs.symlinkSync(path.join(outside, 'outside.nfo'), path.join(directory, 'ABC-001.nfo'))
    const store = createNfoFileStore({ authorize: assertMediaLibraryRootFile })

    const located = locateNfoSidecar({
      anchorPath: path.join(directory, 'ABC-001.mp4'),
      root,
      directoryVideoCodes: ['ABC-001'],
      fileStore: store
    })
    assert.equal(located.status, 'unsafe')
    assert.deepEqual(located.warnings.map((warning) => warning.code), ['unsafe-sidecar'])

    fs.unlinkSync(path.join(directory, 'ABC-001.nfo'))
    touch(path.join(directory, 'shared.nfo'), '<movie/>')
    fs.linkSync(path.join(directory, 'shared.nfo'), path.join(directory, 'ABC-001.nfo'))
    touch(path.join(directory, 'ABC-001-CD2.mp4'))
    fs.linkSync(path.join(directory, 'shared.nfo'), path.join(directory, 'ABC-001-CD2.nfo'))
    const first = locateNfoSidecar({
      anchorPath: path.join(directory, 'ABC-001.mp4'),
      root,
      directoryVideoCodes: ['ABC-001', 'ABC-001'],
      fileStore: store
    })
    const second = locateNfoSidecar({
      anchorPath: path.join(directory, 'ABC-001-CD2.mp4'),
      root,
      directoryVideoCodes: ['ABC-001', 'ABC-001'],
      fileStore: store
    })
    assert.equal(first.physicalKey, second.physicalKey)

    fs.unlinkSync(path.join(directory, 'ABC-001-CD2.nfo'))
    fs.symlinkSync(path.join(outside, 'outside.nfo'), path.join(directory, 'ABC-001-CD2.nfo'))
    assert.throws(() => store.readText(second.capability!), /媒体库根目录/u)
  })
})
