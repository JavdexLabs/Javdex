import fs from 'node:fs'
import path from 'node:path'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import {
  getMediaLibrary,
  getMediaLibraryRoot,
  MediaLibraryRepoError
} from '@library/db/mediaLibraryRepo'
import { isPathUnderRoot } from '../scanner/libraryPathUtils'

const MANAGED_ROOT_FILE_ERROR = '只能操作身份有效的启用媒体库根目录内文件'

export interface AuthorizedMediaLibraryRoot {
  readonly root: MediaLibraryRoot
  readonly realPath: string
}

export interface AuthorizedMediaLibraryRootFile extends AuthorizedMediaLibraryRoot {
  readonly fileRealPath: string
  readonly stat: fs.Stats
}

export type AuthorizedMediaLibraryRootFileInspector = (
  libraryId: number,
  rootId: number,
  filePath: string,
  expectedRoot?: Readonly<MediaLibraryRoot>
) => AuthorizedMediaLibraryRootFile

function rejectManagedRootFile(): never {
  throw new Error(MANAGED_ROOT_FILE_ERROR)
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function hasSamePersistedIdentity(
  current: Readonly<MediaLibraryRoot>,
  expected: Readonly<MediaLibraryRoot>
): boolean {
  return (
    current.id === expected.id &&
    current.libraryId === expected.libraryId &&
    current.normalizedPath === expected.normalizedPath &&
    current.normalizedRealPath === expected.normalizedRealPath &&
    current.deviceId === expected.deviceId &&
    current.inode === expected.inode
  )
}

function requireCurrentRootIdentity(
  root: Readonly<MediaLibraryRoot>,
  expectedRoot: Readonly<MediaLibraryRoot> = root
): string {
  if (
    root.state !== 'active' ||
    expectedRoot.state !== 'active' ||
    !root.realPath ||
    !root.normalizedRealPath ||
    !root.deviceId ||
    !root.inode ||
    !expectedRoot.realPath ||
    !expectedRoot.normalizedRealPath ||
    !expectedRoot.deviceId ||
    !expectedRoot.inode ||
    !hasSamePersistedIdentity(root, expectedRoot)
  ) {
    rejectManagedRootFile()
  }

  let currentRoot: ReturnType<typeof resolveMediaLibraryRootIdentity>
  try {
    currentRoot = resolveMediaLibraryRootIdentity(root.path)
  } catch {
    rejectManagedRootFile()
  }
  if (
    !currentRoot.realPath ||
    currentRoot.normalizedRealPath !== root.normalizedRealPath ||
    currentRoot.deviceId !== root.deviceId ||
    currentRoot.inode !== root.inode
  ) {
    rejectManagedRootFile()
  }
  return currentRoot.realPath
}

function assertRootFile(
  filePath: string,
  root: Readonly<MediaLibraryRoot>,
  allowMissing: boolean,
  expectedRoot: Readonly<MediaLibraryRoot> = root
): void {
  if (!path.isAbsolute(filePath)) rejectManagedRootFile()
  const currentRootPath = requireCurrentRootIdentity(root, expectedRoot)

  try {
    const resolvedFilePath = fs.realpathSync.native(filePath)
    if (!fs.statSync(resolvedFilePath).isFile()) rejectManagedRootFile()
    if (!isPathUnderRoot(resolvedFilePath, currentRootPath)) rejectManagedRootFile()
  } catch (error) {
    if (
      !allowMissing ||
      !isMissingPathError(error) ||
      (!isPathUnderRoot(filePath, root.path) &&
        (!root.realPath || !isPathUnderRoot(filePath, root.realPath)))
    ) {
      rejectManagedRootFile()
    }
  }
}

function authorizeRootInspection(
  libraryId: number,
  rootId: number,
  expectedRoot?: Readonly<MediaLibraryRoot>
): AuthorizedMediaLibraryRoot {
  const root = requireActivePersistedRoot(libraryId, rootId)
  return {
    root,
    realPath: requireCurrentRootIdentity(root, expectedRoot ?? root)
  }
}

function inspectAuthorizedRootFile(
  filePath: string,
  authorization: AuthorizedMediaLibraryRoot
): AuthorizedMediaLibraryRootFile {
  if (!path.isAbsolute(filePath)) rejectManagedRootFile()
  try {
    const fileRealPath = fs.realpathSync.native(filePath)
    const stat = fs.statSync(fileRealPath)
    if (!stat.isFile() || !isPathUnderRoot(fileRealPath, authorization.realPath)) {
      rejectManagedRootFile()
    }
    return { ...authorization, fileRealPath, stat }
  } catch {
    rejectManagedRootFile()
  }
}

/**
 * Create a plan-scoped inspector. Root identity is authorized once per root while every
 * source file still receives its own canonical-path and regular-file check.
 */
export function createAuthorizedMediaLibraryRootFileInspector(): AuthorizedMediaLibraryRootFileInspector {
  const roots = new Map<string, AuthorizedMediaLibraryRoot>()
  return (libraryId, rootId, filePath, expectedRoot) => {
    const key = `${libraryId}:${rootId}`
    let authorization = roots.get(key)
    if (!authorization) {
      authorization = authorizeRootInspection(libraryId, rootId, expectedRoot)
      roots.set(key, authorization)
    } else if (expectedRoot && !hasSamePersistedIdentity(authorization.root, expectedRoot)) {
      rejectManagedRootFile()
    }
    return inspectAuthorizedRootFile(filePath, authorization)
  }
}

/** Authorize an existing file operation against a persisted, currently active root identity. */
export function assertMediaLibraryRootFile(
  filePath: string,
  root: Readonly<MediaLibraryRoot>,
  expectedRoot: Readonly<MediaLibraryRoot> = root
): void {
  assertRootFile(filePath, root, false, expectedRoot)
}

/**
 * Authorize a source-file removal. Missing sources may still have their database record removed,
 * but any file that appears must resolve inside the same persisted physical root.
 */
export function assertMediaLibraryRootDeletionTarget(
  filePath: string,
  root: Readonly<MediaLibraryRoot>,
  expectedRoot: Readonly<MediaLibraryRoot> = root
): void {
  assertRootFile(filePath, root, true, expectedRoot)
}

/** Verify that the persisted root and its current filesystem target still match a frozen snapshot. */
export function assertMediaLibraryRootIdentity(
  root: Readonly<MediaLibraryRoot>,
  expectedRoot: Readonly<MediaLibraryRoot> = root
): void {
  requireCurrentRootIdentity(root, expectedRoot)
}

function requireActivePersistedRoot(libraryId: number, rootId: number): MediaLibraryRoot {
  const library = getMediaLibrary(libraryId)
  if (!library) {
    throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  }
  if (library.status !== 'active') {
    throw new MediaLibraryRepoError('LIBRARY_ARCHIVED', '已归档媒体库必须恢复后才能修改。')
  }
  const root = getMediaLibraryRoot(libraryId, rootId)
  if (!root || root.state !== 'active') {
    throw new MediaLibraryRepoError(
      'ROOT_NOT_FOUND',
      '媒体库根目录不存在、已停用或不属于该媒体库。'
    )
  }
  return root
}

/** Main-process authorization for a root snapshot that may have crossed an async boundary. */
export function authorizeMediaLibraryRoot(
  libraryId: number,
  rootId: number,
  expectedRoot?: Readonly<MediaLibraryRoot>
): MediaLibraryRoot {
  const root = requireActivePersistedRoot(libraryId, rootId)
  assertMediaLibraryRootIdentity(root, expectedRoot ?? root)
  return root
}

/** Main-process authorization for an existing file and a frozen root snapshot. */
export function authorizeMediaLibraryRootFile(
  libraryId: number,
  rootId: number,
  filePath: string,
  expectedRoot?: Readonly<MediaLibraryRoot>
): MediaLibraryRoot {
  const root = requireActivePersistedRoot(libraryId, rootId)
  assertMediaLibraryRootFile(filePath, root, expectedRoot ?? root)
  return root
}

/** Main-process authorization for deleting a file-backed record after an async scan. */
export function authorizeMediaLibraryRootDeletionTarget(
  libraryId: number,
  rootId: number,
  filePath: string,
  expectedRoot?: Readonly<MediaLibraryRoot>
): MediaLibraryRoot {
  const root = requireActivePersistedRoot(libraryId, rootId)
  assertMediaLibraryRootDeletionTarget(filePath, root, expectedRoot ?? root)
  return root
}
