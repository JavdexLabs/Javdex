import path from 'node:path'
export { assertMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'

export function assertFileNameOnly(fileName: string): void {
  if (fileName !== path.basename(fileName) || fileName === '.' || fileName === '..') {
    throw new Error('新名称只能包含文件名，不能包含目录')
  }
}
