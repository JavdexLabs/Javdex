import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
export const linuxCompileScripts = ['playback-runtime.mjs', 'playback-linux-elf.test.mjs',
  'playback-source-materials.mjs', 'packaging-runtime.mjs', 'playback-linux-helper-smoke.mjs']

/** A minimal, local-only development context. Never copy a profile or the repo. */
export function stageLinuxCompileContext(headers, destination) {
  headers = fs.realpathSync(headers)
  destination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination))
  const relative = path.relative(headers, destination)
  assert.ok(relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative), 'Linux compile context must be outside the SDK headers')
  for (const file of ['node_api.h', 'node_version.h', 'v8.h']) assert.ok(fs.statSync(path.join(headers, file)).isFile(), `Missing Electron SDK header: ${file}`)
  if (fs.existsSync(destination)) {
    assert.ok(fs.lstatSync(destination).isDirectory() && !fs.lstatSync(destination).isSymbolicLink() && fs.readdirSync(destination).length === 0, 'Linux compile context must be a new or empty directory')
  } else fs.mkdirSync(destination)
  fs.mkdirSync(path.join(destination, 'scripts'))
  for (const file of linuxCompileScripts) fs.copyFileSync(path.join(repository, 'scripts', file), path.join(destination, 'scripts', file))
  fs.copyFileSync(path.join(repository, 'scripts/playback-linux-compile.Dockerfile'), path.join(destination, 'Dockerfile'))
  fs.cpSync(path.join(repository, 'apps/desktop/src/main/player/native'), path.join(destination, 'native'), {
    recursive: true, filter: source => {
      const stat = fs.lstatSync(source)
      assert.ok(!stat.isSymbolicLink(), 'Native compile inputs must not contain symlinks')
      return stat.isDirectory() || stat.isFile() && /(?:CMakeLists\.txt|\.(?:cpp|mm|h))$/.test(source)
    }
  })
  fs.cpSync(headers, path.join(destination, 'electron-headers'), { recursive: true, filter: source => {
    const stat = fs.lstatSync(source)
    assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'SDK compile inputs must be regular files/directories')
    return true
  } })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [headers, directory, ...extra] = process.argv.slice(2)
  assert.ok(headers && directory && extra.length === 0, 'Use stage-playback-linux-context.mjs <Electron include/node> <empty context directory>')
  stageLinuxCompileContext(path.resolve(headers), path.resolve(directory))
  console.log(`Staged isolated Linux compile context: ${path.resolve(directory)}`)
}
