import fs from 'node:fs'
import path from 'node:path'
import { structuredError } from '@shared/protocol/errors'
import { resolveLibraryMediaMounts } from '@library/runtime/host'
import type { BrowseMediaMountInput, BrowseMediaMountResult } from '@shared/mediaLibraryIpcContract'

function validSegment(segment: string): boolean {
  return Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('\\') && !segment.includes(':')
}

export function resolveMountSelectionPath(mountSelectionId: string, relativePath = ''): string {
  const mounts = resolveLibraryMediaMounts()
  const configured = Object.hasOwn(mounts, mountSelectionId) ? mounts[mountSelectionId] : undefined
  if (!configured) {
    throw structuredError('INVALID_INPUT', '未知的媒体挂载选择', {
      field: 'root.mountSelectionId'
    })
  }
  if (!fs.existsSync(configured)) {
    throw structuredError('INVALID_INPUT', '媒体挂载不存在或已卸载')
  }
  const root = fs.realpathSync.native(configured)
  const segments = relativePath === '' ? [] : relativePath.split('/')
  if (segments.some((segment) => !validSegment(segment)) || relativePath.length > 1024) {
    throw structuredError('INVALID_INPUT', '无效的媒体挂载子目录', { field: 'root.relativePath' })
  }
  let selected = root
  for (const segment of segments) {
    selected = path.join(selected, segment)
    try {
      if (fs.lstatSync(selected).isSymbolicLink()) {
        throw structuredError('INVALID_INPUT', '不能选择符号链接目录', { field: 'root.relativePath' })
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_INPUT') throw error
      throw structuredError('INVALID_INPUT', '媒体挂载子目录不存在或无法访问', { field: 'root.relativePath' })
    }
  }
  const resolved = fs.realpathSync.native(selected)
  const remainder = path.relative(root, resolved)
  if (remainder === '..' || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder) || !fs.statSync(resolved).isDirectory()) {
    throw structuredError('INVALID_INPUT', '所选目录不在媒体挂载内', { field: 'root.relativePath' })
  }
  return resolved
}

export function browseMediaMount(input: BrowseMediaMountInput): BrowseMediaMountResult {
  const mounts = Object.entries(resolveLibraryMediaMounts())
    .map(([id, configured]) => ({ id, path: configured }))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!input.mountSelectionId) {
    if (input.relativePath || input.search) throw structuredError('INVALID_INPUT', '请先选择媒体挂载')
    return { mounts, current: null, directories: [], truncated: false }
  }
  const relativePath = input.relativePath ?? ''
  const search = input.search?.trim().toLocaleLowerCase() ?? ''
  const selected = resolveMountSelectionPath(input.mountSelectionId, relativePath)
  const directories = fs.readdirSync(selected, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validSegment(entry.name) && relativePath.length + entry.name.length + 1 <= 1024 && entry.name.toLocaleLowerCase().includes(search))
    .map((entry) => ({
      name: entry.name,
      relativePath: relativePath ? `${relativePath}/${entry.name}` : entry.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    mounts,
    current: { mountSelectionId: input.mountSelectionId, relativePath, path: selected },
    directories: directories.slice(0, 500),
    truncated: directories.length > 500
  }
}
