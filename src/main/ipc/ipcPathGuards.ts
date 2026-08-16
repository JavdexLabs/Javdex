import fs from 'node:fs'
import path from 'node:path'
import { isPathUnderRoot } from '../scanner/libraryPathUtils'

export function assertConfiguredLibraryFile(filePath: string, libraryPaths: string[]): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error('只能操作已配置媒体库目录内的文件')
  }

  let resolvedFilePath: string
  try {
    resolvedFilePath = fs.realpathSync.native(filePath)
  } catch {
    throw new Error('只能操作已配置媒体库目录内的文件')
  }

  const isInsideConfiguredRoot = libraryPaths.some((libraryPath) => {
    try {
      return isPathUnderRoot(resolvedFilePath, fs.realpathSync.native(libraryPath))
    } catch {
      return false
    }
  })
  if (!isInsideConfiguredRoot) {
    throw new Error('只能操作已配置媒体库目录内的文件')
  }
}

export function assertFileNameOnly(fileName: string): void {
  if (fileName !== path.basename(fileName) || fileName === '.' || fileName === '..') {
    throw new Error('新名称只能包含文件名，不能包含目录')
  }
}
