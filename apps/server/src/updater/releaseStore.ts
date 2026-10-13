import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { t as list, x as extract } from 'tar'
import { isServerReleasePath, releaseDescriptorSchema, SERVER_RELEASE_REQUIRED_FILES, SERVER_RUNTIME_ID, type ServerReleaseDescriptor, type ServerUpdateManifest } from '@shared/serverUpdateTypes'
import type { UpdaterConfig } from './config'
import { readJsonIfExists, writeJsonAtomic } from './files'

const run = promisify(execFile)
export { isServerReleasePath as releasePath } from '@shared/serverUpdateTypes'
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export function releaseId(manifest: ServerUpdateManifest): string {
  return `${manifest.version}-${manifest.archive.sha256}`
}
export class ReleaseStore {
  readonly platform = `linux/${process.arch === 'x64' ? 'amd64' : process.arch}`
  constructor(private readonly config: UpdaterConfig) {}
  private registry(): Record<string, string> {
    return z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).parse(readJsonIfExists(path.join(this.config.stateDir, 'installed-releases.json')) ?? {})
  }
  private async register(id: string): Promise<void> {
    writeJsonAtomic(path.join(this.config.stateDir, 'installed-releases.json'), { ...this.registry(), [id]: await fileHash(path.join(this.directory(id), 'release.json')) })
  }
  async verifyInstalled(id: string): Promise<void> {
    const directory = this.directory(id)
    const expected = this.registry()[id]
    if (!expected || await fileHash(path.join(directory, 'release.json')) !== expected) throw new Error('已安装发行记录缺失或损坏')
    await this.verify(directory)
  }
  async retain(current: string, previous: string): Promise<void> {
    const registry = this.registry()
    for (const id of Object.keys(registry)) {
      if (id === current || id === previous) continue
      const directory = this.directory(id)
      if (fs.existsSync(directory)) {
        // Unknown/corrupted content is evidence, not a cleanup target.
        if (await fileHash(path.join(directory, 'release.json')) !== registry[id]) continue
        await this.verify(directory)
        await fs.promises.rm(directory, { recursive: true, force: true })
      }
      delete registry[id]
    }
    writeJsonAtomic(path.join(this.config.stateDir, 'installed-releases.json'), registry)
  }
  directory(id: string): string {
    if (!/^[\w.-]+-[a-f0-9]{64}$/.test(id)) throw new Error('无效服务端发行目录')
    const directory = path.join(this.config.releasesDir, id)
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('发行目录不能是符号链接')
    return directory
  }
  current(): string | null {
    const saved = readJsonIfExists(path.join(this.config.stateDir, 'active-release.json')) as { format?: number; id?: string } | null
    if (!saved) return null
    if (saved.format !== 1 || !saved.id) throw new Error('当前发行记录损坏')
    this.directory(saved.id)
    return saved.id
  }
  select(id: string): void {
    this.descriptor(this.directory(id))
    if (!this.registry()[id]) throw new Error('不能选择未完成安装的发行目录')
    writeJsonAtomic(path.join(this.config.stateDir, 'active-release.json'), { format: 1, id })
  }
  descriptor(directory: string): ServerReleaseDescriptor {
    const file = path.join(directory, 'release.json')
    if (fs.statSync(file).size > 4 * 1024 ** 2) throw new Error('发行清单超过限制')
    const result = releaseDescriptorSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (result.platform !== this.platform || result.runtime !== SERVER_RUNTIME_ID) throw new Error('发行包与当前容器运行环境不兼容')
    for (const name of Object.keys(result.files)) if (!isServerReleasePath(name) || name === 'release.json') throw new Error('发行清单含不安全路径')
    for (const name of SERVER_RELEASE_REQUIRED_FILES) if (!Object.hasOwn(result.files, name)) throw new Error(`完整发行包缺少 ${name}`)
    return result
  }
  async verify(directory: string, manifest?: ServerUpdateManifest): Promise<ServerReleaseDescriptor> {
    const descriptor = this.descriptor(directory)
    if (manifest && (descriptor.version !== manifest.version || descriptor.build !== manifest.build || descriptor.targetSchema !== manifest.targetSchema || descriptor.platform !== manifest.platform || descriptor.runtime !== manifest.runtime)) throw new Error('发行内容与签名清单不一致')
    const found = new Set<string>()
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name)
        const name = path.relative(directory, file).split(path.sep).join('/')
        if (entry.isSymbolicLink()) throw new Error('发行包不允许符号链接')
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile()) {
          if (name === 'release.json') continue
          const expected = descriptor.files[name]
          if (!Object.hasOwn(descriptor.files, name) || !expected || fs.statSync(file).size !== expected.bytes || await fileHash(file) !== expected.sha256) throw new Error(`发行文件缺失、额外或损坏：${name}`)
          found.add(name)
        } else throw new Error('发行包含特殊文件')
      }
    }
    await walk(directory)
    if (found.size !== Object.keys(descriptor.files).length) throw new Error('发行包文件集合不完整')
    const product = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { version?: string }
    if (product.version !== descriptor.version) throw new Error('发行包应用版本不一致')
    return descriptor
  }
  async checkNative(directory: string): Promise<void> {
    // A native load failure must not crash the long-lived management process.
    await run(process.execPath, ['-e', "const r=require('node:module').createRequire(process.argv[1]);const D=r('better-sqlite3');const d=new D(':memory:');d.prepare('SELECT 1').get();d.close();const sharp=r('sharp');sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer().catch(()=>process.exit(1));", path.join(directory, 'package.json')], {
      timeout: 30000, maxBuffer: 65536, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' }
    }).catch(() => { throw new Error('发行包原生依赖与运行环境不兼容') })
  }
  private async seal(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await this.seal(file)
      else {
        fs.chmodSync(file, 0o644)
        const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      }
    }
    fs.chmodSync(directory, 0o755)
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  async bootstrap(): Promise<void> {
    const current = this.current()
    if (current) { await this.verifyInstalled(current); return }
    const descriptor = this.descriptor(this.config.seedDir)
    const fingerprint = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
    const id = `${descriptor.version}-${fingerprint}`
    const destination = this.directory(id)
    if (!fs.existsSync(destination)) {
      const staging = await fs.promises.mkdtemp(path.join(this.config.stateDir, 'seed-'))
      try {
        for (const name of [...Object.keys(descriptor.files), 'release.json']) {
          const source = path.join(this.config.seedDir, name)
          if (!fs.lstatSync(source).isFile()) throw new Error('镜像发行内容含非法文件')
          const target = path.join(staging, name)
          await fs.promises.mkdir(path.dirname(target), { recursive: true })
          await fs.promises.copyFile(source, target)
        }
        await this.verify(staging); await this.seal(staging)
        fs.renameSync(staging, destination)
        const fd = fs.openSync(this.config.releasesDir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }) }
    } else await this.verify(destination)
    await this.register(id)
    this.select(id)
  }
  async prepare(manifest: ServerUpdateManifest, archive: string): Promise<void> {
    if (manifest.platform !== this.platform || manifest.runtime !== SERVER_RUNTIME_ID) throw new Error('请升级匹配的容器运行环境')
    if (fs.statSync(archive).size !== manifest.archive.bytes || await fileHash(archive) !== manifest.archive.sha256) throw new Error('发行包校验失败')
    const destination = this.directory(releaseId(manifest))
    if (fs.existsSync(destination)) { await this.verify(destination, manifest); await this.checkNative(destination); await this.register(releaseId(manifest)); return }
    const entries = new Set<string>()
    let expanded = 0
    const checkEntry = (name: string, entry: { type?: string; size?: number; mode?: number }): boolean => {
      const clean = entry.type === 'Directory' ? name.replace(/\/$/, '') : name
      if (!isServerReleasePath(clean) || !['File', 'Directory'].includes(entry.type ?? '') || entries.has(clean) || ((entry.mode ?? 0) & 0o7000)) throw new Error('发行包包含链接、重复或不安全条目')
      entries.add(clean)
      expanded += entry.size ?? 0
      if (entries.size > 22000 || expanded > manifest.archive.unpackedBytes || expanded > 8 * 1024 ** 3) throw new Error('发行包解压内容超过限制')
      return true
    }
    function filter(this: { abort(error: Error): void }, name: string, entry: { type?: string; size?: number; mode?: number }): boolean {
      try { return checkEntry(name, entry) }
      catch (error) { this.abort(error as Error); return false }
    }
    await list({ file: archive, strict: true, filter })
    if (expanded !== manifest.archive.unpackedBytes) throw new Error('发行包展开大小与签名清单不一致')
    const space = fs.statfsSync(this.config.stateDir)
    if (Number(space.bavail) * Number(space.bsize) < expanded + 64 * 1024 ** 2) throw new Error('发行目录空间不足')
    const staging = await fs.promises.mkdtemp(path.join(this.config.stateDir, `release-${randomUUID()}-`))
    try {
      entries.clear(); expanded = 0
      await extract({ file: archive, cwd: staging, strict: true, preserveOwner: false, filter })
      await this.verify(staging, manifest)
      await this.checkNative(staging)
      await this.seal(staging)
      fs.renameSync(staging, destination)
      const fd = fs.openSync(this.config.releasesDir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      await this.register(releaseId(manifest))
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }) }
  }
}
