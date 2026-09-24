import fs from 'node:fs'
import path from 'node:path'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { sameLogicalCode, type DirectoryVideoIdentityInput } from './directoryVideoIdentity'
import type { ManagedRootFileCapability } from './managedRootFileCapability'
import type { IssuedNfoFile, NfoFileStore } from './nfoFileStore'

export { sameLogicalCode } from './directoryVideoIdentity'

export type NfoSidecarWarningCode =
  | 'ambiguous-movie-nfo'
  | 'shadowed-movie-nfo'
  | 'unsafe-sidecar'

export interface NfoSidecarWarning {
  code: NfoSidecarWarningCode
  message: string
}

export interface NfoSidecarLocation {
  status: 'missing' | 'found' | 'ambiguous' | 'unsafe'
  capability?: ManagedRootFileCapability
  filename?: string
  physicalKey?: string
  warnings: NfoSidecarWarning[]
}

export interface LocateNfoSidecarInput {
  anchorPath: string
  root: Readonly<MediaLibraryRoot>
  /** Filename-derived identities for every video/STRM anchor in this directory. */
  directoryVideoCodes: DirectoryVideoIdentityInput
  /** Reuse directory entries collected by the current scan; never cache across scans. */
  directorySidecars?: ReadonlyMap<string, string>
  fileStore: NfoFileStore
}

export function indexNfoSidecars(names: Iterable<string>): ReadonlyMap<string, string> {
  const files = new Map<string, string>()
  for (const name of names) {
    if (path.extname(name).toLowerCase() === '.nfo') files.set(name, name)
  }
  for (const name of [...files.keys()]) {
    if (!files.has(name.toLowerCase())) files.set(name.toLowerCase(), name)
  }
  return files
}

function issue(
  fileStore: NfoFileStore,
  root: Readonly<MediaLibraryRoot>,
  filePath: string
): IssuedNfoFile | null {
  try {
    return fileStore.issue(root, filePath)
  } catch {
    return null
  }
}

export function locateNfoSidecar(input: LocateNfoSidecarInput): NfoSidecarLocation {
  const directory = path.dirname(input.anchorPath)
  const stem = path.basename(input.anchorPath, path.extname(input.anchorPath))
  let sidecars = input.directorySidecars
  if (!sidecars) {
    try { sidecars = indexNfoSidecars(fs.readdirSync(directory)) } catch { sidecars = new Map() }
  }
  const find = (name: string): string | null => {
    const matched = sidecars.get(name) ?? sidecars.get(name.toLowerCase())
    return matched ? path.join(directory, matched) : null
  }
  const exactPath = find(`${stem}.nfo`)
  const moviePath = find('movie.nfo')

  if (exactPath) {
    const exact = issue(input.fileStore, input.root, exactPath)
    if (!exact) {
      return {
        status: 'unsafe',
        warnings: [{ code: 'unsafe-sidecar', message: '同名 NFO 不在已授权媒体库根目录内' }]
      }
    }
    const warnings: NfoSidecarWarning[] = []
    if (moviePath && path.resolve(moviePath) !== path.resolve(exactPath)) {
      const movie = issue(input.fileStore, input.root, moviePath)
      if (!movie) {
        warnings.push({ code: 'unsafe-sidecar', message: 'movie.nfo 不在已授权媒体库根目录内' })
      } else {
        try {
          if (!input.fileStore.readBytes(exact.capability).equals(input.fileStore.readBytes(movie.capability))) {
            warnings.push({
              code: 'shadowed-movie-nfo',
              message: '同名 NFO 与 movie.nfo 内容不同，已采用同名 NFO'
            })
          }
        } catch {
          warnings.push({ code: 'unsafe-sidecar', message: '无法安全比较同名 NFO 与 movie.nfo' })
        }
      }
    }
    return { status: 'found', ...exact, warnings }
  }

  if (!moviePath) return { status: 'missing', warnings: [] }
  if (!sameLogicalCode(input.directoryVideoCodes)) {
    return {
      status: 'ambiguous',
      warnings: [{ code: 'ambiguous-movie-nfo', message: '目录包含多个影片身份，已跳过 movie.nfo' }]
    }
  }
  const movie = issue(input.fileStore, input.root, moviePath)
  if (!movie) {
    return {
      status: 'unsafe',
      warnings: [{ code: 'unsafe-sidecar', message: 'movie.nfo 不在已授权媒体库根目录内' }]
    }
  }
  return { status: 'found', ...movie, warnings: [] }
}
