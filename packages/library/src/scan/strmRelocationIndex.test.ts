import { it } from 'node:test'
import assert from 'node:assert/strict'
import { StrmRelocationIndex } from './strmRelocationIndex'
import { normalizeExternalVideoResource } from '@shared/videoResourceLinks'

function resource(id: number, name = `MOV-${id}.strm`, locator = `https://example.test/${id}.mp4`) {
  return { library_id: 1, resource_id: id, video_id: id, root_id: 1 as number | null,
    source_path: `/old/${name}`, kind: 'direct' as const, locator }
}

function fixture(rows: ReturnType<typeof resource>[]) {
  const records = new Map(rows.map((row) => [row.resource_id, row]))
  let revision = { connection: {}, changes: 0, dataVersion: 1 }
  let lists = 0
  let reads = 0
  const states = new Map<string, 'present' | 'missing' | 'unknown'>()
  const unavailableRootIds = new Set<number>()
  const index = new StrmRelocationIndex({
    revision: () => ({ ...revision }),
    list: () => { lists++; return [...records.values()] },
    get: (id) => { reads++; return records.get(id) ?? null },
    getByPath: (source) => [...records.values()].find((r) => r.source_path === source) ?? null,
    inspect: (source) => states.get(source) ?? 'missing',
    unavailableRootIds
  })
  return { index, records, states, unavailableRootIds,
    metrics: () => ({ lists, reads }),
    write: (external = false) => { revision = { ...revision,
      changes: revision.changes + (external ? 0 : 1),
      dataVersion: revision.dataVersion + (external ? 1 : 0) } }
  }
}

const target = (locator: string) => normalizeExternalVideoResource(locator, 'direct').resourceKey

it('matches unique missing sources and retains filename, target, root and uncertainty rules', () => {
  const a = resource(1, 'same.strm')
  const b = resource(2, 'same.strm', a.locator)
  b.source_path = '/other/same.strm'
  const f = fixture([a, b, resource(3, 'different.strm', a.locator)])
  const find = () => f.index.find('/new/same.strm', target(a.locator))
  assert.equal(find(), null, 'two missing sources are ambiguous')
  f.states.set(b.source_path, 'unknown')
  assert.equal(find()?.resource_id, 1)
  f.states.set(a.source_path, 'present')
  assert.equal(find(), null)
  f.states.set(a.source_path, 'missing')
  f.unavailableRootIds.add(1)
  assert.equal(find(), null)
  f.unavailableRootIds.clear()
  assert.equal(f.index.find('/new/SAME.strm', target(a.locator)), null)
  assert.equal(f.index.find('/new/same.strm', target(`${a.locator}?other=1`)), null)
  assert.equal(f.metrics().lists, 1, 'presence and root availability are not cached')
})

it('incrementally tracks same-scan insertions and target/path changes, but invalidates unknown writes', () => {
  const a = resource(1)
  const f = fixture([a])
  assert.equal(f.index.find('/new/MOV-1.strm', target(a.locator))?.resource_id, 1)
  const b = resource(2)
  f.index.mutate(b.source_path, () => { f.records.set(2, b); f.write() })
  assert.equal(f.index.find('/new/MOV-2.strm', target(b.locator))?.resource_id, 2)
  const moved = { ...a, source_path: '/moved/renamed.strm', locator: 'https://example.test/changed.mp4' }
  f.index.mutate(moved.source_path, () => { f.records.set(1, moved); f.write() })
  assert.equal(f.index.find('/new/MOV-1.strm', target(a.locator)), null)
  assert.equal(f.index.find('/new/renamed.strm', target(moved.locator))?.resource_id, 1)
  assert.equal(f.metrics().lists, 1)
  f.records.delete(1); f.write()
  assert.equal(f.index.find('/new/renamed.strm', target(moved.locator)), null)
  assert.equal(f.metrics().lists, 2)
  f.records.set(1, moved); f.write(true)
  assert.equal(f.index.find('/new/renamed.strm', target(moved.locator))?.resource_id, 1)
  assert.equal(f.metrics().lists, 3)
})

it('does not acknowledge unrelated writes or a failed mutation as a complete cache update', () => {
  const a = resource(1)
  const f = fixture([a])
  f.index.find(a.source_path, target(a.locator))
  f.records.set(2, resource(2)); f.write()
  f.index.mutate(a.source_path, () => f.write())
  assert.equal(f.index.find('/new/MOV-2.strm', target(resource(2).locator))?.resource_id, 2)
  assert.equal(f.metrics().lists, 2)
  assert.throws(() => f.index.mutate(a.source_path, () => { f.records.delete(1); f.write(); throw Error('failed') }))
  assert.equal(f.index.find(a.source_path, target(a.locator)), null)
  assert.equal(f.metrics().lists, 3)
})

it('retains the cache for known pending writes but cannot hide an intervening external write', () => {
  const a = resource(1)
  const f = fixture([a])
  f.index.find(a.source_path, target(a.locator))
  f.index.mutateWithoutResourceChanges(() => f.write())
  assert.equal(f.index.find(a.source_path, target(a.locator))?.resource_id, 1)
  assert.equal(f.metrics().lists, 1)
  f.records.delete(1); f.write(true)
  f.index.mutateWithoutResourceChanges(() => f.write())
  assert.equal(f.index.find(a.source_path, target(a.locator)), null)
  assert.equal(f.metrics().lists, 2)
})

for (const size of [10000, 20000, 300382, 600764]) {
  it(`examines one matching candidate per lookup in a ${size}-resource relocation`, () => {
    const f = fixture(Array.from({ length: size }, (_, id) => resource(id)))
    for (let id = 0; id < size; id++) {
      assert.equal(f.index.find(`/new/MOV-${id}.strm`, target(resource(id).locator))?.resource_id, id)
    }
    assert.deepEqual(f.metrics(), { lists: 1, reads: size })
  })
}

it('indexes target keys as well as filenames when many directories use the same filename', () => {
  const size = 20000
  const f = fixture(Array.from({ length: size }, (_, id) => ({
    ...resource(id, 'movie.strm'), source_path: `/old/${id}/movie.strm`
  })))
  for (let id = 0; id < size; id++) {
    assert.equal(f.index.find('/new/movie.strm', target(resource(id).locator))?.resource_id, id)
  }
  assert.deepEqual(f.metrics(), { lists: 1, reads: size })
})

it('keeps a warm index across nested audit-only writes inside a known resource mutation', () => {
  const a = resource(1), f = fixture([a])
  f.index.find(a.source_path, target(a.locator))
  const moved = { ...a, source_path: '/new/renamed.strm', locator: 'https://example.test/new.mp4' }
  const result = f.index.mutate(moved.source_path, () => {
    f.records.set(1, moved); f.write()
    return f.index.mutateWithoutResourceChanges(() => {
      f.write()
      return f.index.mutateWithoutResourceChanges(() => { f.write(); return 'audit saved' })
    })
  })
  assert.equal(result, 'audit saved')
  assert.equal(f.index.find(a.source_path, target(a.locator)), null)
  assert.equal(f.index.find(moved.source_path, target(moved.locator))?.resource_id, 1)
  assert.equal(f.metrics().lists, 1)
  f.index.mutateWithoutResourceChanges(() => f.write())
  assert.equal(f.index.find(moved.source_path, target(moved.locator))?.resource_id, 1)
  assert.equal(f.metrics().lists, 1, 'standalone audit-only writes also retain warmth')
})

it('invalidates after outer resource failure and restores tracking depth for later audit-only writes', () => {
  const a = resource(1), f = fixture([a])
  f.index.find(a.source_path, target(a.locator))
  assert.throws(() => f.index.mutate(a.source_path, () => {
    f.records.delete(1); f.write()
    f.index.mutateWithoutResourceChanges(() => f.write())
    throw new Error('outer failed')
  }), /outer failed/)
  assert.equal(f.index.find(a.source_path, target(a.locator)), null)
  assert.equal(f.metrics().lists, 2)
  f.index.mutateWithoutResourceChanges(() => f.write())
  assert.equal(f.index.find(a.source_path, target(a.locator)), null)
  assert.equal(f.metrics().lists, 2, 'finally restored depth, allowing standalone revision tracking')
})

it('does not bypass a nested mutation of another resource or hide an external change', () => {
  const a = resource(1), b = resource(2), f = fixture([a])
  f.index.find(a.source_path, target(a.locator))
  f.index.mutate(a.source_path, () => {
    f.write()
    f.index.mutate(b.source_path, () => { f.records.set(2, b); f.write() })
  })
  assert.equal(f.index.find(b.source_path, target(b.locator))?.resource_id, 2)
  assert.equal(f.metrics().lists, 2, 'nested resource mutation still forces a conservative rebuild')
  f.index.mutate(a.source_path, () => {
    f.index.mutateWithoutResourceChanges(() => { f.records.delete(2); f.write(true) })
    f.write()
  })
  assert.equal(f.index.find(b.source_path, target(b.locator)), null)
  assert.equal(f.metrics().lists, 3, 'outer dataVersion comparison still detects external writes')
})
