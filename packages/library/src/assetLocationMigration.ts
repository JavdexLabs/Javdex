import fs from 'node:fs'
import path from 'node:path'
import type { AssetCryptoProgress } from '@shared/libraryTypes'
import { invalidateAssetCache } from '@library/assetCache'
import {
  ensureMediaAssetDirsAt,
  mediaAssetsPathForSettings
} from '@library/assetStoragePaths'

type ProgressFn = (p: AssetCryptoProgress) => void
type AssetFile = { rel: string; abs: string }
type CopiedAssetFile = {
  source: string
  destination: string
  deviceId: number
  inode: number
}

function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

function isTempAssetFile(name: string): boolean {
  return /\.tmp-\d+$/i.test(name)
}

function listAssetFiles(
  root: string,
  allowMissing = true,
  missingMessage = '媒体资源目录当前不可用'
): AssetFile[] {
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (allowMissing) return []
      throw new Error(missingMessage)
    }
    throw error
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error('媒体资源根目录不能是符号链接')
  }
  if (!rootStat.isDirectory()) {
    throw new Error('媒体资源路径必须是目录')
  }
  const out: AssetFile[] = []

  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (isTempAssetFile(name)) continue
      const abs = path.join(dir, name)
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink()) {
        throw new Error(`媒体资源目录不能包含符号链接：${toPosixRel(root, abs)}`)
      }
      if (stat.isDirectory()) {
        walk(abs)
        continue
      }
      if (!stat.isFile()) continue
      out.push({ rel: toPosixRel(root, abs), abs })
    }
  }

  walk(root)
  return out
}

function filesHaveEqualContents(left: string, right: string): boolean {
  const leftStat = fs.statSync(left)
  const rightStat = fs.statSync(right)
  if (leftStat.size !== rightStat.size) return false

  const leftFd = fs.openSync(left, 'r')
  const rightFd = fs.openSync(right, 'r')
  const leftBuffer = Buffer.allocUnsafe(64 * 1024)
  const rightBuffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let offset = 0
    while (offset < leftStat.size) {
      const length = Math.min(leftBuffer.length, leftStat.size - offset)
      const leftRead = fs.readSync(leftFd, leftBuffer, 0, length, offset)
      const rightRead = fs.readSync(rightFd, rightBuffer, 0, length, offset)
      if (
        leftRead === 0 ||
        rightRead === 0 ||
        leftRead !== rightRead ||
        !leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))
      ) {
        return false
      }
      offset += leftRead
    }
    return true
  } finally {
    fs.closeSync(leftFd)
    fs.closeSync(rightFd)
  }
}

function assertTargetRootReadyForMigration(root: string, sourceFiles: AssetFile[]): void {
  const existingFiles = listAssetFiles(root)
  if (existingFiles.length > 0) {
    const sourceByRelativePath = new Map(sourceFiles.map((file) => [file.rel, file.abs]))
    const canResume = existingFiles.every((file) => {
      const source = sourceByRelativePath.get(file.rel)
      return source != null && filesHaveEqualContents(source, file.abs)
    })
    if (!canResume) {
      throw new Error('目标文件夹已包含其他媒体资源文件，请选择其他空目录')
    }
    return
  }

  // A prior default layout may leave empty subfolders behind; clear them before migrate-in.
  removeTreeIfEmpty(root)
}

function isNestedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function resolvePhysicalPathThroughExistingParents(input: string): string {
  let current = input
  const unresolvedSegments: string[] = []
  while (true) {
    try {
      return path.resolve(fs.realpathSync(current), ...unresolvedSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      unresolvedSegments.unshift(path.basename(current))
      current = parent
    }
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function statExistingPath(input: string): fs.Stats | null {
  try {
    return fs.statSync(input)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

function pathOrAncestorHasIdentity(input: string, identity: fs.Stats): boolean {
  let current = input
  while (true) {
    const stat = statExistingPath(current)
    if (stat && sameFileIdentity(stat, identity)) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function assertPreparedMigrationIntact(
  sourceRoot: string,
  targetRoot: string,
  preparedFiles: AssetFile[]
): AssetFile[] {
  const currentSourceFiles = listAssetFiles(
    sourceRoot,
    false,
    '源媒体资源目录当前不可用，迁移未提交'
  )
  const currentTargetFiles = listAssetFiles(
    targetRoot,
    false,
    '目标媒体资源目录当前不可用，迁移未提交'
  )
  if (
    currentSourceFiles.length !== preparedFiles.length ||
    currentTargetFiles.length !== preparedFiles.length
  ) {
    throw new Error('媒体资源文件在迁移期间发生变化，迁移未提交')
  }

  const sourceByRelativePath = new Map(currentSourceFiles.map((file) => [file.rel, file]))
  const targetByRelativePath = new Map(currentTargetFiles.map((file) => [file.rel, file]))
  for (const prepared of preparedFiles) {
    const source = sourceByRelativePath.get(prepared.rel)
    const target = targetByRelativePath.get(prepared.rel)
    if (!source || !target || !filesHaveEqualContents(source.abs, target.abs)) {
      throw new Error('媒体资源文件在迁移期间发生变化，迁移未提交')
    }
  }
  return currentSourceFiles
}

function copyFileAtomic(src: string, dest: string): boolean {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) {
    const stat = fs.lstatSync(dest)
    if (!stat.isFile() || stat.isSymbolicLink() || !filesHaveEqualContents(src, dest)) {
      throw new Error(`目标媒体资源文件发生冲突：${dest}`)
    }
    return false
  }
  const tmp = `${dest}.tmp-${process.pid}`
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dest)
  return true
}

function removeCopiedFileIfUnchanged(file: CopiedAssetFile): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file.destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.dev !== file.deviceId ||
    stat.ino !== file.inode ||
    !fs.existsSync(file.source) ||
    !filesHaveEqualContents(file.source, file.destination)
  ) {
    return
  }
  fs.unlinkSync(file.destination)
}

function removeTreeIfEmpty(root: string): void {
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return

  const removeDir = (dir: string): boolean => {
    const entries = fs.readdirSync(dir).filter((name) => !isTempAssetFile(name))
    let empty = true
    for (const name of entries) {
      const abs = path.join(dir, name)
      const stat = fs.lstatSync(abs)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!removeDir(abs)) empty = false
      } else {
        empty = false
      }
    }
    if (empty && dir !== root) {
      fs.rmdirSync(dir)
      return true
    }
    return false
  }

  removeDir(root)
  if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
    fs.rmdirSync(root)
  }
}

export interface PreparedMediaAssetsLocationMigration {
  storedPath: string
  commit: () => void
  rollback: () => void
}

/** Copy assets first; the caller persists the new root before committing old-root cleanup. */
export async function prepareMediaAssetsLocationMigration(
  oldRoot: string,
  newRoot: string,
  onProgress: ProgressFn
): Promise<PreparedMediaAssetsLocationMigration> {
  const from = path.resolve(oldRoot)
  const to = path.resolve(newRoot)
  if (from === to) {
    return {
      storedPath: mediaAssetsPathForSettings(to),
      commit: () => undefined,
      rollback: () => undefined
    }
  }
  if (isNestedPath(from, to) || isNestedPath(to, from)) {
    throw new Error('媒体资源源目录和目标目录不能相互嵌套')
  }

  const files = listAssetFiles(from, false, '源媒体资源目录当前不可用，无法迁移')
  const sourceIdentity = fs.statSync(from)
  const targetIdentity = statExistingPath(to)
  if (targetIdentity && sameFileIdentity(sourceIdentity, targetIdentity)) {
    throw new Error('媒体资源目标目录与当前目录实际指向同一位置')
  }
  if (
    pathOrAncestorHasIdentity(to, sourceIdentity) ||
    (targetIdentity != null && pathOrAncestorHasIdentity(from, targetIdentity))
  ) {
    throw new Error('媒体资源源目录和目标目录不能相互嵌套')
  }
  const physicalFrom = fs.realpathSync(from)
  const physicalTo = resolvePhysicalPathThroughExistingParents(to)
  if (physicalFrom === physicalTo) {
    throw new Error('媒体资源目标目录与当前目录实际指向同一位置')
  }
  if (isNestedPath(physicalFrom, physicalTo) || isNestedPath(physicalTo, physicalFrom)) {
    throw new Error('媒体资源源目录和目标目录不能相互嵌套')
  }
  assertTargetRootReadyForMigration(to, files)
  ensureMediaAssetDirsAt(to)
  onProgress({
    phase: 'relocate',
    current: 0,
    total: Math.max(files.length, 1),
    currentFile: '',
    status: 'running'
  })

  const copiedThisRun: CopiedAssetFile[] = []
  try {
    for (let i = 0; i < files.length; i++) {
      const { rel, abs } = files[i]
      const dest = path.join(to, ...rel.split('/'))
      onProgress({
        phase: 'relocate',
        current: i + 1,
        total: files.length,
        currentFile: rel,
        status: 'running'
      })
      if (copyFileAtomic(abs, dest)) {
        const copiedStat = fs.lstatSync(dest)
        copiedThisRun.push({
          source: abs,
          destination: dest,
          deviceId: copiedStat.dev,
          inode: copiedStat.ino
        })
      }
      if (i % 20 === 0) {
        await new Promise((r) => setImmediate(r))
      }
    }
  } catch (error) {
    for (const copied of [...copiedThisRun].reverse()) {
      removeCopiedFileIfUnchanged(copied)
    }
    removeTreeIfEmpty(to)
    onProgress({
      phase: 'relocate',
      current: 0,
      total: files.length,
      currentFile: '',
      status: 'error',
      error: (error as Error).message
    })
    throw error
  }

  let settled = false
  return {
    storedPath: mediaAssetsPathForSettings(to),
    commit: () => {
      if (settled) throw new Error('媒体资源迁移已经结束')
      const sourceFilesToRemove = assertPreparedMigrationIntact(from, to, files)
      settled = true
      for (const { abs } of sourceFilesToRemove) {
        try {
          fs.unlinkSync(abs)
        } catch (error) {
          console.error('Failed to remove migrated media asset source:', abs, error)
        }
      }
      try {
        removeTreeIfEmpty(from)
      } catch (error) {
        console.error('Failed to remove the old media asset root:', from, error)
      }
      invalidateAssetCache()
      try {
        onProgress({
          phase: 'relocate',
          current: files.length,
          total: files.length,
          currentFile: '',
          status: 'done'
        })
      } catch (error) {
        console.error('Failed to report completed media asset migration:', error)
      }
    },
    rollback: () => {
      if (settled) throw new Error('媒体资源迁移已经结束')
      settled = true
      for (const copied of [...copiedThisRun].reverse()) {
        removeCopiedFileIfUnchanged(copied)
      }
      removeTreeIfEmpty(to)
      invalidateAssetCache()
      onProgress({
        phase: 'relocate',
        current: 0,
        total: files.length,
        currentFile: '',
        status: 'error',
        error: '媒体资源位置更新未提交'
      })
    }
  }
}
