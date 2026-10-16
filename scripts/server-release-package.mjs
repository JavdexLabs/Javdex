import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isServerReleasePath, releaseDescriptorSchema, SERVER_RELEASE_REQUIRED_FILES, SERVER_RUNTIME_ID, SERVER_ENVIRONMENT_VERSION } from '../packages/contracts/src/serverUpdateTypes.ts'

const inside = (file, root) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
async function hash(file) {
  const result = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) result.update(chunk)
  return result.digest('hex')
}
export async function describeRelease(directory, platform) {
  directory = fs.realpathSync(directory)
  const product = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const build = JSON.parse(fs.readFileSync(path.join(directory, 'build-info.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(product.version) || !/^[a-f0-9]{40}$/.test(build.build) || !Number.isInteger(build.targetSchema) || build.targetSchema < 19 || !/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('Invalid production release identity')
  const files = Object.create(null)
  const walk = async (folder, ancestors = new Set()) => {
    const real = fs.realpathSync(folder)
    if (!inside(real, directory) || ancestors.has(real)) throw new Error('Release contains escaping or recursive symlinks')
    const next = new Set(ancestors).add(real)
    for (const name of (await fs.promises.readdir(folder)).sort()) {
      const file = path.join(folder, name)
      const relative = path.relative(directory, file).split(path.sep).join('/')
      if (relative === 'release.json' || relative === 'node_modules/.bin' || relative.startsWith('node_modules/.cache/')) continue
      if (!isServerReleasePath(relative)) throw new Error('Unsafe release filename')
      const actual = fs.realpathSync(file)
      if (!inside(actual, directory)) throw new Error('Release symlink escapes its closure')
      const stat = await fs.promises.stat(file)
      if (stat.isDirectory()) await walk(file, next)
      else if (stat.isFile()) files[relative] = { bytes: stat.size, sha256: await hash(file) }
      else throw new Error('Release contains a special file')
    }
  }
  await walk(directory)
  for (const name of SERVER_RELEASE_REQUIRED_FILES) if (!files[name]) throw new Error(`Incomplete production closure: ${name}`)
  return releaseDescriptorSchema.parse({ format: 1, version: product.version, build: build.build, platform, runtime: SERVER_RUNTIME_ID, environmentVersion: SERVER_ENVIRONMENT_VERSION, targetSchema: build.targetSchema, files })
}
export async function packageRelease(directory, archive, platform) {
  const descriptor = await describeRelease(directory, platform)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-release-package-'))
  try {
    for (const name of Object.keys(descriptor.files)) {
      const destination = path.join(staging, name)
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.copyFile(path.join(directory, name), destination)
      fs.chmodSync(destination, 0o644)
    }
    fs.writeFileSync(path.join(staging, 'release.json'), `${JSON.stringify(descriptor)}\n`)
    const { c } = await import('tar')
    await c({ file: archive, cwd: staging, gzip: true, portable: true, noMtime: true }, [...Object.keys(descriptor.files).sort(), 'release.json'])
    return { descriptor, bytes: fs.statSync(archive).size, unpackedBytes: Object.values(descriptor.files).reduce((sum, file) => sum + file.bytes, fs.statSync(path.join(staging, 'release.json')).size), sha256: await hash(archive) }
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, directory, argument] = process.argv.slice(2)
  if (!directory || !['metadata', 'archive'].includes(mode)) throw new Error('Use metadata <production directory> [linux/arch] or archive <directory> <archive>')
  const platform = mode === 'metadata' ? argument || `linux/${process.arch === 'x64' ? 'amd64' : process.arch}` : JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8')).platform
  if (mode === 'metadata') fs.writeFileSync(path.join(directory, 'release.json'), `${JSON.stringify(await describeRelease(directory, platform))}\n`)
  else { if (!argument) throw new Error('Missing archive destination'); await packageRelease(directory, argument, platform) }
}
