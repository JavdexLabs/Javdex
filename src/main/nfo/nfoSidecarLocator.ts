import fs from 'node:fs'
import path from 'node:path'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import type { ManagedRootFileCapability } from '../metadata-sources'
import type { IssuedNfoFile, NfoFileStore } from './nfoFileStore'

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
  directoryVideoCodes: Array<string | null>
  fileStore: NfoFileStore
}

function findCaseInsensitiveFile(directory: string, targetName: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(directory)
  } catch {
    return null
  }
  const exact = names.find((name) => name === targetName)
  const matched = exact ?? names.find((name) => name.toLowerCase() === targetName.toLowerCase())
  return matched ? path.join(directory, matched) : null
}

function sameLogicalCode(values: Array<string | null>): boolean {
  if (values.length === 1) return true
  const normalized = values.map((value) => {
    if (!value) return null
    try {
      return normalizeVideoCode(value)
    } catch {
      return null
    }
  })
  return normalized.length > 0 && normalized.every((value) => value && value === normalized[0])
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
  const exactPath = findCaseInsensitiveFile(directory, `${stem}.nfo`)
  const moviePath = findCaseInsensitiveFile(directory, 'movie.nfo')

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
