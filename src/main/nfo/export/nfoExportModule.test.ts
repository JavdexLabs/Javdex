import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import type { NfoExportPlanRequest } from '@shared/nfoExportTypes'
import { NfoExportModule } from './nfoExportModule'
import type { NfoExportRepository, NfoExportResourceSnapshot } from './nfoExportRepository'

const JPEG_1X1 = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let tempRoot: string | null = null

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

const request: NfoExportPlanRequest = {
  libraryIds: [1],
  profileId: 'portable-v1',
  includeCover: true,
  includeFanart: true,
  includeSamples: false,
  includeActorAvatars: false,
  collisionPolicy: 'skip'
}

function setup(): { root: MediaLibraryRoot; anchor: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-export-'))
  const anchor = path.join(tempRoot, 'ABP-123.mp4')
  fs.writeFileSync(anchor, 'video')
  return {
    anchor,
    root: {
      id: 1,
      libraryId: 1,
      path: tempRoot,
      normalizedPath: tempRoot,
      realPath: tempRoot,
      normalizedRealPath: tempRoot,
      deviceId: null,
      inode: null,
      position: 0,
      state: 'active',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01'
    }
  }
}

function snapshot(anchor: string, root: MediaLibraryRoot): NfoExportResourceSnapshot {
  return {
    resourceId: 10,
    libraryId: 1,
    libraryRevision: 1,
    videoId: 20,
    rootId: 1,
    root,
    kind: 'local',
    anchorPath: anchor,
    resourceSize: 5,
    resourceMtime: fs.statSync(anchor).mtimeMs,
    code: 'ABP-123',
    title: 'Example',
    summary: 'Summary',
    coverPath: 'covers/example.jpg',
    posterPath: undefined,
    tags: ['Drama'],
    actors: [],
    ratings: [],
    identities: [],
    samples: []
  }
}

function moduleWith(
  current: { value: NfoExportResourceSnapshot },
  overrides: Partial<ConstructorParameters<typeof NfoExportModule>[0]> = {}
): NfoExportModule {
  const repository: NfoExportRepository = {
    listActiveLibraries: () => [{ id: 1, name: 'Library' }],
    listResourceSnapshots: () => [current.value],
    getResourceSnapshot: () => current.value
  }
  return new NfoExportModule({
    repository,
    assetStore: {
      readBytes: () => JPEG_1X1,
      detectImageExtension: () => '.jpg'
    },
    authorizeAnchor: (_libraryId, _rootId, _filePath, expectedRoot) => expectedRoot!,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    ...overrides
  })
}

describe('NfoExportModule', () => {
  it('plans without writing and applies an exact-stem NFO plus portable cover', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current)
    const plan = module.plan(request)

    assert.equal(fs.existsSync(path.join(tempRoot!, 'ABP-123.nfo')), false)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'ABP-123-poster.jpg')), false)
    assert.equal(plan.preview.summary.createCount, 2)
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.preview), true)
    assert.equal(Object.isFrozen(plan.files[0]), true)
    assert.doesNotMatch(JSON.stringify(plan.preview), new RegExp(tempRoot!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

    const report = await module.apply(plan, 'task-1', { isTerminated: () => false }, () => undefined)
    assert.equal(report.writtenCount, 2)
    assert.match(fs.readFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'utf8'), /<title>Example<\/title>/u)
    assert.deepEqual(fs.readFileSync(path.join(tempRoot!, 'ABP-123-poster.jpg')), JPEG_1X1)
  })

  it('keeps the default skip policy and rejects a changed target under replace', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    fs.writeFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'existing')
    const module = moduleWith(current)
    const skipped = module.plan(request)
    assert.equal(skipped.preview.files.find((file) => file.kind === 'nfo')?.action, 'skip-existing')

    const replacement = module.plan({ ...request, collisionPolicy: 'replace' })
    fs.writeFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'changed after plan')
    const report = await module.apply(replacement, 'task-2', { isTerminated: () => false }, () => undefined)
    const nfo = report.items.find((item) => item.kind === 'nfo')
    assert.equal(nfo?.disposition, 'stale-plan')
    assert.equal(fs.readFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'utf8'), 'changed after plan')
  })

  it('marks every planned file stale when source metadata changes', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current)
    const plan = module.plan(request)
    current.value = { ...current.value, title: 'Changed' }
    const report = await module.apply(plan, 'task-3', { isTerminated: () => false }, () => undefined)
    assert.equal(report.items.every((item) => item.disposition === 'stale-plan'), true)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'ABP-123.nfo')), false)
  })

  it('exports a local STRM source anchor and counts resources without anchors separately', () => {
    const fixture = setup()
    const withAnchor = { ...snapshot(fixture.anchor, fixture.root), kind: 'direct' }
    const withoutAnchor = { ...snapshot(fixture.anchor, fixture.root), resourceId: 11, anchorPath: null, rootId: null, root: null }
    const repository: NfoExportRepository = {
      listActiveLibraries: () => [{ id: 1, name: 'Library' }],
      listResourceSnapshots: () => [withAnchor, withoutAnchor],
      getResourceSnapshot: () => withAnchor
    }
    const module = new NfoExportModule({
      repository,
      assetStore: { readBytes: () => JPEG_1X1, detectImageExtension: () => '.jpg' },
      authorizeAnchor: (_a, _b, _c, root) => root!,
      now: () => new Date('2026-09-05T00:00:00.000Z')
    })
    const plan = module.plan(request)
    assert.equal(plan.preview.summary.resourceCount, 1)
    assert.equal(plan.preview.summary.skippedNoAnchorCount, 1)
  })

  it('terminates only between files and leaves completed atomic writes intact', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current)
    const plan = module.plan(request)
    let terminated = false
    const report = await module.apply(
      plan,
      'task-4',
      { isTerminated: () => terminated },
      (completed) => { if (completed === 1) terminated = true }
    )
    assert.equal(report.terminated, true)
    assert.equal(report.writtenCount, 1)
    assert.equal(report.items.some((item) => item.disposition === 'cancelled'), true)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'ABP-123.nfo')), true)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'ABP-123-poster.jpg')), false)
    assert.equal(fs.readdirSync(tempRoot!).some((name) => name.includes('.tmp')), false)
  })

  it('isolates an image conversion failure from the NFO write', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current, {
      assetStore: {
        readBytes: () => JPEG_1X1,
        detectImageExtension: () => '.webp'
      },
      encodeImage: () => { throw new Error('decode failed') }
    })
    const plan = module.plan(request)
    const report = await module.apply(plan, 'task-5', { isTerminated: () => false }, () => undefined)
    assert.equal(report.items.find((item) => item.kind === 'nfo')?.disposition, 'written')
    assert.equal(report.items.find((item) => item.kind === 'cover')?.disposition, 'failed')
  })

  it('reports an atomic write failure per item and continues later files', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    let writes = 0
    const module = moduleWith(current, {
      writeAtomically: (targetPath, bytes) => {
        writes += 1
        if (writes === 1) throw new Error('read-only target')
        fs.writeFileSync(targetPath, bytes)
      }
    })
    const report = await module.apply(module.plan(request), 'task-6', { isTerminated: () => false }, () => undefined)
    assert.equal(report.items[0].disposition, 'failed')
    assert.equal(report.items[1].disposition, 'written')
  })

  it('plans samples and actor avatars with stable portable paths and references', async () => {
    const fixture = setup()
    const current = { value: {
      ...snapshot(fixture.anchor, fixture.root),
      samples: ['samples/first.jpg', 'samples/second.jpg'],
      actors: [{ name: 'Alice / A', gender: 'female' as const, avatarPath: 'avatars/alice.jpg', actressRevision: 2 }]
    } }
    const module = moduleWith(current)
    const plan = module.plan({ ...request, includeSamples: true, includeActorAvatars: true })
    assert.equal(plan.preview.summary.sampleCount, 2)
    assert.equal(plan.preview.files.some((file) => file.displayName.endsWith('extrafanart/ABP-123-001.jpg')), true)
    assert.equal(plan.preview.files.some((file) => file.displayName.endsWith('.actors/Alice _ A.jpg')), true)
    await module.apply(plan, 'task-7', { isTerminated: () => false }, () => undefined)
    const nfo = fs.readFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'utf8')
    assert.match(nfo, /extrafanart\/ABP-123-002.jpg/u)
    assert.match(nfo, /\.actors\/Alice _ A.jpg/u)
  })

  it('marks colliding sanitized actor avatar targets and omits ambiguous NFO references', async () => {
    const fixture = setup()
    const current = { value: {
      ...snapshot(fixture.anchor, fixture.root),
      actors: [
        { name: 'A/B', avatarPath: 'avatars/one.jpg', actressRevision: 1 },
        { name: 'A:B', avatarPath: 'avatars/two.jpg', actressRevision: 1 }
      ]
    } }
    const module = moduleWith(current, {
      assetStore: {
        readBytes: (storedPath) => Buffer.from(storedPath, 'utf8'),
        detectImageExtension: () => '.jpg'
      }
    })
    const plan = module.plan({ ...request, includeActorAvatars: true })

    assert.equal(plan.preview.files.some((file) =>
      file.kind === 'actor-avatar' && file.action === 'conflict'), true)
    assert.equal(plan.preview.warnings.some((warning) => warning.includes('演员头像目标发生碰撞')), true)
    await module.apply(plan, 'task-actors', { isTerminated: () => false }, () => undefined)
    assert.doesNotMatch(fs.readFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'utf8'), /<thumb>\.actors\//u)
  })

  it('treats case and Unicode-normalization-equivalent actor targets as collisions', () => {
    const fixture = setup()
    const current = { value: {
      ...snapshot(fixture.anchor, fixture.root),
      actors: [
        { name: 'Alice', avatarPath: 'avatars/one.jpg', actressRevision: 1 },
        { name: 'alice', avatarPath: 'avatars/two.jpg', actressRevision: 1 },
        { name: 'Cafe\u0301', avatarPath: 'avatars/three.jpg', actressRevision: 1 },
        { name: 'Café', avatarPath: 'avatars/four.jpg', actressRevision: 1 }
      ]
    } }
    const plan = moduleWith(current, {
      assetStore: {
        readBytes: (storedPath) => Buffer.from(storedPath, 'utf8'),
        detectImageExtension: () => '.jpg'
      }
    }).plan({ ...request, includeActorAvatars: true })

    assert.equal(plan.preview.files.filter((file) =>
      file.kind === 'actor-avatar' && file.action === 'conflict').length, 2)
    assert.equal(plan.preview.warnings.some((warning) => warning.includes('演员头像目标发生碰撞')), true)
  })

  it('makes Windows device actor names portable before planning their target', () => {
    const fixture = setup()
    const current = { value: {
      ...snapshot(fixture.anchor, fixture.root),
      actors: [{ name: 'CON', avatarPath: 'avatars/con.jpg', actressRevision: 1 }]
    } }
    const plan = moduleWith(current).plan({ ...request, includeActorAvatars: true })
    assert.equal(plan.preview.files.some((file) =>
      file.kind === 'actor-avatar' && file.displayName.endsWith('.actors/_CON.jpg')), true)
  })

  it('keeps unreadable selected images as unavailable plan items without blocking NFO', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current, {
      assetStore: {
        readBytes: () => { throw new Error('encrypted asset unavailable') },
        detectImageExtension: () => null
      }
    })
    const plan = module.plan(request)
    assert.equal(plan.preview.summary.unavailableCount, 1)
    const report = await module.apply(plan, 'task-8', { isTerminated: () => false }, () => undefined)
    assert.equal(report.items.find((item) => item.kind === 'nfo')?.disposition, 'written')
    assert.equal(report.items.find((item) => item.kind === 'cover')?.disposition, 'unavailable')
  })

  it('warns about requested missing artwork, avatars, and populated fields omitted by a profile', () => {
    const fixture = setup()
    const current = { value: {
      ...snapshot(fixture.anchor, fixture.root),
      originalTitle: 'Original',
      publisher: 'Publisher',
      ratings: [{ source: 'javdb', average: 4.2 }],
      identities: [{ source: 'imdb', code: 'tt123' }],
      actors: [{ name: 'Alice', gender: 'female' as const, actressRevision: 1 }]
    } }
    const module = moduleWith(current)
    const plan = module.plan({
      ...request,
      profileId: 'infuse-current',
      includeActorAvatars: true
    })

    assert.equal(plan.preview.warnings.some((warning) => warning.includes('没有可导出的 fanart')), true)
    assert.equal(plan.preview.warnings.some((warning) => warning.includes('1 位演员没有可导出的头像')), true)
    assert.equal(plan.preview.warnings.some((warning) =>
      warning.includes('profile 不表示这些已有字段：原始标题、发行方、评分、演员性别、站点身份')), true)
  })

  it('uses the video stem itself for Infuse cover output and local reference', async () => {
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current)
    const plan = module.plan({ ...request, profileId: 'infuse-current' })
    assert.equal(plan.preview.files.some((file) => file.displayName.endsWith('ABP-123.jpg')), true)
    await module.apply(plan, 'task-9', { isTerminated: () => false }, () => undefined)
    assert.match(fs.readFileSync(path.join(tempRoot!, 'ABP-123.nfo'), 'utf8'), /<thumb aspect="poster">ABP-123.jpg<\/thumb>/u)
  })

  it('plans each physical resource, deduplicates identical targets, and warns only on same-directory identity collisions', () => {
    const fixture = setup()
    const secondDirectory = path.join(tempRoot!, 'second')
    fs.mkdirSync(secondDirectory)
    const secondAnchor = path.join(secondDirectory, 'ABP-123.mp4')
    fs.writeFileSync(secondAnchor, 'video')
    const first = snapshot(fixture.anchor, fixture.root)
    const sameTarget = { ...first, resourceId: 11 }
    const otherDirectory = { ...first, resourceId: 12, anchorPath: secondAnchor }
    let list: NfoExportResourceSnapshot[] = [first, sameTarget, otherDirectory]
    const repository: NfoExportRepository = {
      listActiveLibraries: () => [{ id: 1, name: 'Library' }],
      listResourceSnapshots: () => list,
      getResourceSnapshot: (resourceId) => list.find((item) => item.resourceId === resourceId) ?? null
    }
    const module = new NfoExportModule({
      repository,
      assetStore: { readBytes: () => JPEG_1X1, detectImageExtension: () => '.jpg' },
      authorizeAnchor: (_a, _b, _c, root) => root!,
      now: () => new Date('2026-09-05T00:00:00.000Z')
    })
    const plan = module.plan(request)
    assert.equal(plan.preview.summary.resourceCount, 3)
    assert.equal(plan.preview.summary.videoCount, 1)
    assert.equal(plan.preview.files.length, 4)
    assert.equal(plan.preview.warnings.some((warning) => /相同规范化番号/u.test(warning)), false)

    list = [first, { ...first, resourceId: 13, videoId: 21 }]
    const conflict = module.plan(request)
    assert.equal(conflict.preview.summary.conflictCount, 2)
    assert.equal(conflict.preview.warnings.some((warning) => /相同规范化番号/u.test(warning)), true)
  })

  it('reports real read-only directory failures without leaving temporary files', async (context) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      context.skip('root can write through read-only mode bits')
      return
    }
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current)
    const plan = module.plan(request)
    fs.chmodSync(tempRoot!, 0o555)
    let dispositions: string[] = []
    try {
      const report = await module.apply(plan, 'task-10', { isTerminated: () => false }, () => undefined)
      dispositions = report.items.map((item) => item.disposition)
    } finally {
      fs.chmodSync(tempRoot!, 0o755)
    }
    assert.equal(dispositions.every((disposition) => disposition === 'failed'), true)
    assert.equal(fs.readdirSync(tempRoot!).some((name) => name.includes('.tmp')), false)
  })

  it('rejects a sample-directory symlink introduced after planning', async () => {
    const fixture = setup()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-export-outside-'))
    const current = { value: { ...snapshot(fixture.anchor, fixture.root), samples: ['samples/one.jpg'] } }
    const module = moduleWith(current)
    const plan = module.plan({ ...request, includeSamples: true })
    fs.symlinkSync(outside, path.join(tempRoot!, 'extrafanart'), 'dir')
    try {
      const report = await module.apply(plan, 'task-11', { isTerminated: () => false }, () => undefined)
      assert.equal(report.items.find((item) => item.kind === 'sample')?.disposition, 'stale-plan')
      assert.deepEqual(fs.readdirSync(outside), [])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not fingerprint a nested export target through a pre-existing symlink', () => {
    const fixture = setup()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-export-outside-'))
    const current = { value: { ...snapshot(fixture.anchor, fixture.root), samples: ['samples/one.jpg'] } }
    fs.writeFileSync(path.join(outside, 'ABP-123-001.jpg'), 'outside')
    fs.symlinkSync(outside, path.join(tempRoot!, 'extrafanart'), 'dir')
    try {
      const plan = moduleWith(current).plan({ ...request, includeSamples: true })
      assert.equal(plan.preview.files.find((file) => file.kind === 'sample')?.action, 'conflict')
      assert.equal(fs.readFileSync(path.join(outside, 'ABP-123-001.jpg'), 'utf8'), 'outside')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('revalidates a skip target parent before following a newly introduced symlink', async () => {
    const fixture = setup()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-export-outside-'))
    const current = { value: { ...snapshot(fixture.anchor, fixture.root), samples: ['samples/one.jpg'] } }
    const nested = path.join(tempRoot!, 'extrafanart')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, 'ABP-123-001.jpg'), JPEG_1X1)
    const module = moduleWith(current)
    const plan = module.plan({ ...request, includeSamples: true })
    fs.rmSync(nested, { recursive: true })
    fs.writeFileSync(path.join(outside, 'ABP-123-001.jpg'), JPEG_1X1)
    fs.symlinkSync(outside, nested, 'dir')
    try {
      const report = await module.apply(plan, 'task-skip-symlink', { isTerminated: () => false }, () => undefined)
      assert.equal(report.items.find((item) => item.kind === 'sample')?.disposition, 'stale-plan')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('creates consumer-readable sidecars and preserves an existing target mode on replace', async (context) => {
    if (process.platform === 'win32') {
      context.skip('POSIX mode bits are not portable to Windows')
      return
    }
    const fixture = setup()
    const current = { value: snapshot(fixture.anchor, fixture.root) }
    const module = moduleWith(current)
    const nfoOnly = { ...request, includeCover: false, includeFanart: false }
    await module.apply(module.plan(nfoOnly), 'task-mode-create', { isTerminated: () => false }, () => undefined)
    const target = path.join(tempRoot!, 'ABP-123.nfo')
    assert.equal(fs.statSync(target).mode & 0o777, 0o666 & ~process.umask())

    fs.chmodSync(target, 0o640)
    await module.apply(
      module.plan({ ...nfoOnly, collisionPolicy: 'replace' }),
      'task-mode-replace',
      { isTerminated: () => false },
      () => undefined
    )
    assert.equal(fs.statSync(target).mode & 0o777, 0o640)
  })
})
