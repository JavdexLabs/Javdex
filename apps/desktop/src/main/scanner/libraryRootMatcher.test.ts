import { it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createLibraryRootMatcher } from './libraryRootMatcher'
import { isPathUnderRoot } from './libraryPathUtils'

for (const paths of [path.posix, path.win32]) {
  const windows = paths.sep === '\\'
  const base = windows ? 'C:\\media' : '/media'
  const join = (...parts: string[]) => paths.join(base, ...parts)
  const roots = [
    { path: join('a', 'nested'), realPath: join('real') },
    { path: join('a') },
    { path: join('a'), realPath: join('other') },
    { path: join('..hidden'), realPath: '' },
    { path: base },
    { path: windows ? 'D:\\other' : '/elsewhere' }
  ]
  const files = [base, join('a'), join('a', 'nested'), join('a', 'nested', 'f'),
    join('ab', 'f'), join('real', 'f'), join('other', 'f'), join('..hidden', 'f'),
    join('a', '..hidden', 'f'), join('a', 'child', '..hidden', 'f'),
    join('a', '..', 'a', 'f'), join('a', '.', 'f'), join('a', 'f').toUpperCase(),
    '', '.', 'relative', windows ? 'C:relative' : '../relative',
    windows ? 'D:\\other\\f' : '/elsewhere/f', windows ? '\\media\\a\\f' : '//media//a//f']
  it(`matches original find by object identity for ${windows ? 'win32' : 'posix'} paths and both alias modes`, () => {
    for (const ordered of [roots, [...roots].reverse()]) {
      for (const aliases of [false, true]) {
        const match = createLibraryRootMatcher(ordered, aliases, paths)
        for (const file of files) {
          const expected = ordered.find(root => isPathUnderRoot(file, root.path, paths) ||
            Boolean(aliases && root.realPath && isPathUnderRoot(file, root.realPath, paths)))
          assert.equal(match(file), expected, JSON.stringify({ file, aliases, roots: ordered }))
        }
      }
    }
  })
  it(`preserves the earliest parent, alias and duplicate root for ${windows ? 'win32' : 'posix'}`, () => {
    const parent = { path: base, realPath: join('real') }
    const child = { path: join('a') }
    const duplicate = { path: base }
    assert.equal(createLibraryRootMatcher([parent, child, duplicate], false, paths)(join('a', 'f')), parent)
    assert.equal(createLibraryRootMatcher([child, parent], false, paths)(join('a', 'f')), child)
    const earlierAlias = { path: join('else'), realPath: join('a') }
    assert.equal(createLibraryRootMatcher([earlierAlias, child], true, paths)(join('a', 'f')), earlierAlias)
    assert.equal(createLibraryRootMatcher([earlierAlias, child], false, paths)(join('a', 'f')), child)
  })
}

it('matches UNC and namespace paths without expanding the old predicate', () => {
  const paths = path.win32
  const roots = [{ path: '\\\\server\\share\\a' }, { path: '\\\\SERVER\\share' },
    { path: '\\\\other\\share' }]
  for (const ordered of [roots, [{ path: '\\\\?\\C:\\media' }, ...roots]]) {
    const match = createLibraryRootMatcher(ordered, false, paths)
    for (const file of ['\\\\server\\share\\a\\f', '\\\\server\\share', '\\\\SERVER\\share\\a',
      '\\\\server\\different\\a', '\\\\?\\C:\\media\\f', '\\\\.\\C:\\media\\f']) {
      assert.equal(match(file), ordered.find(root => isPathUnderRoot(file, root.path, paths)), file)
    }
  }
})

it('keeps relative-root fallback and validation short circuit behavior', () => {
  const first = { path: process.cwd() }
  const bad = { path: null as unknown as string }
  const match = createLibraryRootMatcher([first, bad])
  assert.equal(match(path.join(process.cwd(), 'file')), first)
  assert.throws(() => match(path.parse(process.cwd()).root), TypeError)
  assert.equal(createLibraryRootMatcher([])(null as unknown as string), undefined)
  assert.throws(() => createLibraryRootMatcher([first])(null as unknown as string), TypeError)
  for (const roots of [[{ path: '.' }], [{ path: '' }], [{ path: 'relative' }, first]]) {
    const find = createLibraryRootMatcher(roots)
    for (const file of ['', '.', 'relative/f', '../f', path.join(process.cwd(), 'f')]) {
      assert.equal(find(file), roots.find(root => isPathUnderRoot(file, root.path)))
    }
  }
})

it('does not introduce whitespace or NUL validation', () => {
  const roots = [{ path: '/ media ' }, { path: '/media\0root' }]
  const match = createLibraryRootMatcher(roots, false, path.posix)
  for (const file of ['/ media /f', '/media\0root/f', '/media/f']) {
    assert.equal(match(file), roots.find(root => isPathUnderRoot(file, root.path, path.posix)))
  }
})

it('matches deterministic mixed path cases including Windows lexical edge forms', () => {
  for (const paths of [path.posix, path.win32]) {
    const base = paths.sep === '\\' ? 'C:\\data' : '/data'
    const names = ['a', 'A', 'ab', '..hidden', 'deep/child', 'İ', 'i\u0307', 'K', 'K', ' spaced ', '中文']
    const roots = names.map((name, id) => ({ id, path: paths.resolve(base, name), realPath: paths.resolve(base, 'alias', name) }))
    roots.push({ id: roots.length, path: base, realPath: paths.resolve(base, 'mirror') })
    for (const order of [roots, [...roots].reverse()]) for (const aliases of [false, true]) {
      const match = createLibraryRootMatcher(order, aliases, paths)
      for (const name of names) for (const prefix of [base, paths.join(base, 'alias'), paths.join(base, 'missing')]) {
        for (const suffix of ['', '/file', '/..hidden/file', '/child/..hidden/file', '/../a/file']) {
          const file = paths.resolve(prefix, name + suffix)
          for (const spelling of [file, file.toUpperCase(), paths.sep === '\\' ? file.replaceAll('\\', '/') : file + '/']) {
            assert.equal(match(spelling), order.find(root => isPathUnderRoot(spelling, root.path, paths) ||
              Boolean(aliases && root.realPath && isPathUnderRoot(spelling, root.realPath, paths))), spelling)
          }
        }
      }
    }
  }
  const roots = [{ path: '\\data' }, { path: 'C:\\data' }, { path: '//server/share/data' }]
  const match = createLibraryRootMatcher(roots, false, path.win32)
  for (const file of ['\\data\\file', 'C:\\data\\file', 'D:\\data\\file', '//server/share/data/file']) {
    assert.equal(match(file), roots.find(root => isPathUnderRoot(file, root.path, path.win32)))
  }
})

it('checks only ancestor candidates instead of testing every unrelated root', () => {
  const roots = Array.from({ length: 1000 }, (_, id) => ({ path: `/media/root-${id}` }))
  let checks = 0
  const paths = { ...path.posix, relative: (from: string, to: string) => {
    checks++
    return path.posix.relative(from, to)
  } }
  const file = '/media/root-999/file.mp4'
  const expected = roots.find(root => isPathUnderRoot(file, root.path, paths))
  assert.equal(checks, 1000)
  checks = 0
  assert.equal(createLibraryRootMatcher(roots, false, paths)(file), expected)
  assert.equal(checks, 1)
})
