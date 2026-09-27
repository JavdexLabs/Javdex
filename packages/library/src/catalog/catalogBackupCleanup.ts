import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { digestRequest } from './catalogSecrets'

/** Only task-owned files under the managed backup directory; never source/saved paths. */
export function inspectBackupArtifacts(userDataPath: string, id: string): {
  location: string; paths: string[]; bytes: number; fileCount: number; digest: string
} {
  z.uuid().parse(id)
  const location = path.resolve(userDataPath, 'backups')
  const paths: string[] = []
  const entries: Array<[string, number, number, number]> = []
  let bytes = 0
  let fileCount = 0
  if (!fs.existsSync(location)) return { location, paths, bytes, fileCount, digest: digestRequest([id, entries]) }
  const canonical = fs.realpathSync.native(location)
  const assertPath = (file: string): fs.Stats => {
    const relative = path.relative(location, path.resolve(file))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('备份清理路径越界')
    const stat = fs.lstatSync(file)
    const real = fs.realpathSync.native(file)
    const within = path.relative(canonical, real)
    if (stat.isSymbolicLink() || !within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('备份目录含符号链接或越界路径，不能自动清理')
    return stat
  }
  const scan = (file: string): void => {
    const stat = assertPath(file)
    entries.push([path.relative(location, file), stat.size, stat.mtimeMs, stat.ino])
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) scan(path.join(file, name))
    else if (stat.isFile()) { bytes += stat.size; fileCount++ }
    else throw new Error('备份目录含特殊文件，不能自动清理')
  }
  const add = (file: string): void => {
    // lstat also sees dangling links, which must not be silently followed or ignored.
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return
    scan(file); paths.push(file)
  }
  for (const suffix of ['.javdex-backup', '.javdex-backup.partial', '.javdex-backup.failed']) add(path.join(location, `${id}${suffix}`))
  const operations = path.join(location, 'operations')
  if (fs.lstatSync(operations, { throwIfNoEntry: false })) {
    assertPath(operations)
    const directory = path.join(operations, id)
    if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
      assertPath(directory)
      for (const name of fs.readdirSync(directory).sort()) {
        // Keep the durable receipt, including publication identity and idempotency data.
        if (name !== 'job.json' && name !== 'job.json.tmp') add(path.join(directory, name))
      }
    }
  }
  return { location, paths, bytes, fileCount, digest: digestRequest([id, entries]) }
}

export function removeBackupArtifacts(userDataPath: string, id: string): void {
  // Inspect the entire set before deleting anything, including all descendants.
  const plan = inspectBackupArtifacts(userDataPath, id)
  for (const file of plan.paths) fs.rmSync(file, { recursive: true, force: true })
}
