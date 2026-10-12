import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { type HeaderData } from 'tar'
import { extractPosixRuntime, safeRuntimePath } from './runtimeArchive'
import { runtimeTar } from './runtimeArchiveFixtures'
async function extract(entries: Array<HeaderData & { contents?: string }>, check: (directory: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-tar-'))
  try {
    const archive = path.join(root, 'fixture.tar.gz'), directory = path.join(root, 'expanded')
    await fs.writeFile(archive, runtimeTar(entries)); await fs.mkdir(directory)
    await check(directory, () => extractPosixRuntime(archive, directory, 'release', new AbortController().signal))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
test('POSIX extraction preserves the loader layout and materializes library aliases without filesystem links', async () => {
  await extract([
    { path: 'release/bin/ffmpeg', contents: 'executable' }, { path: 'release/bin/ffprobe', contents: 'probe' },
    { path: 'release/lib/libaudio.so.1.2', contents: 'library' },
    { path: 'release/lib/libaudio.so.1', type: 'SymbolicLink', linkpath: 'libaudio.so.1.2' },
    { path: 'release/lib/libaudio.so', type: 'SymbolicLink', linkpath: 'libaudio.so.1' },
    { path: 'release/lib/libhard.so', type: 'Link', linkpath: 'release/lib/libaudio.so.1.2' },
    { path: 'release/LICENSE', contents: 'license' }, { path: 'release/bin/unused', contents: 'ignored' }
  ], async (directory, run) => {
    await run()
    if (process.platform !== 'win32') assert.ok((await fs.stat(path.join(directory, 'bin/ffmpeg'))).mode & 0o111)
    for (const name of ['libaudio.so', 'libaudio.so.1', 'libhard.so']) {
      assert.equal((await fs.lstat(path.join(directory, 'lib', name))).isSymbolicLink(), false)
      assert.equal(await fs.readFile(path.join(directory, 'lib', name), 'utf8'), 'library')
    }
    assert.equal(await fs.readFile(path.join(directory, 'LICENSE'), 'utf8'), 'license')
    assert.equal(await fs.access(path.join(directory, 'bin/unused')).then(() => true, () => false), false)
  })
})
for (const [name, entries] of [
  ['parent traversal', [{ path: 'release/../llama-server', contents: 'bad' }]],
  ['absolute path', [{ path: '/release/llama-server', contents: 'bad' }]],
  ['foreign prefix', [{ path: 'other/llama-server', contents: 'bad' }]],
  ['duplicate path', [{ path: 'release/llama-server', contents: 'one' }, { path: 'release/llama-server', contents: 'two' }]],
  ['escaping link', [{ path: 'release/libx.so', type: 'SymbolicLink', linkpath: '../outside.so' }]],
  ['missing link target', [{ path: 'release/libx.so', type: 'SymbolicLink', linkpath: 'missing.so' }]],
  ['link cycle', [{ path: 'release/libx.so', type: 'SymbolicLink', linkpath: 'liby.so' }, { path: 'release/liby.so', type: 'SymbolicLink', linkpath: 'libx.so' }]],
  ['size bomb', [{ path: 'release/libx.so', size: 1024 ** 3 + 1 }]]
] as Array<[string, Array<HeaderData & { contents?: string }>]> ) {
  test(`POSIX extraction rejects ${name}`, async () => { await extract(entries, async (_directory, run) => { await assert.rejects(run()) }) })
}
test('runtime inventory paths reject non-portable paths', () => {
  for (const name of ['', '.', '..', '../bin', '/bin', 'a//b', 'a/../b', 'a\\b', 'C:bin', 'a\0b']) assert.equal(safeRuntimePath(name), false)
  assert.equal(safeRuntimePath('lib/libaudio.so.1'), true)
})
