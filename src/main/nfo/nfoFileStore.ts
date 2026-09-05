import fs from 'node:fs'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import type { ManagedRootFileCapability } from '../metadata-sources'
import { MAX_NFO_BYTES } from './nfoArtifactCodec'

interface CapabilityRecord {
  filePath: string
  root: Readonly<MediaLibraryRoot>
  deviceId: string
  inode: string
}

export interface IssuedNfoFile {
  capability: ManagedRootFileCapability
  filename: string
  physicalKey: string
}

export interface NfoFileStore {
  issue(root: Readonly<MediaLibraryRoot>, filePath: string): IssuedNfoFile
  readBytes(capability: ManagedRootFileCapability, maxBytes?: number): Buffer
  readText(capability: ManagedRootFileCapability, maxBytes?: number): string
}

export function createNfoFileStore(options: {
  authorize: (filePath: string, root: Readonly<MediaLibraryRoot>) => void
}): NfoFileStore {
  const capabilities = new WeakMap<ManagedRootFileCapability, CapabilityRecord>()

  const requireRecord = (capability: ManagedRootFileCapability): CapabilityRecord => {
    const record = capabilities.get(capability)
    if (!record) throw new Error('本地文件能力票据无效或已经过期')
    options.authorize(record.filePath, record.root)
    return record
  }

  return {
    issue(root, filePath) {
      options.authorize(filePath, root)
      const resolved = fs.realpathSync.native(filePath)
      const stat = fs.statSync(resolved, { bigint: true })
      if (!stat.isFile()) throw new Error('媒体库根目录内目标不是文件')
      const capability = Object.freeze({}) as ManagedRootFileCapability
      const deviceId = String(stat.dev)
      const inode = String(stat.ino)
      capabilities.set(capability, {
        filePath,
        root: Object.freeze({ ...root }),
        deviceId,
        inode
      })
      return {
        capability,
        filename: filePath.replaceAll('\\', '/').split('/').at(-1) || 'artifact',
        physicalKey: `${deviceId}:${inode}`
      }
    },

    readBytes(capability, maxBytes = MAX_NFO_BYTES) {
      const record = requireRecord(capability)
      const descriptor = fs.openSync(record.filePath, 'r')
      try {
        const stat = fs.fstatSync(descriptor, { bigint: true })
        if (String(stat.dev) !== record.deviceId || String(stat.ino) !== record.inode) {
          throw new Error('媒体库根目录内文件在读取前已经发生变化')
        }
        if (stat.size > maxBytes) throw new Error(`本地文件超过 ${maxBytes} 字节读取上限`)
        const content = fs.readFileSync(descriptor)
        if (content.byteLength > maxBytes) {
          throw new Error(`本地文件超过 ${maxBytes} 字节读取上限`)
        }
        return content
      } finally {
        fs.closeSync(descriptor)
      }
    },

    readText(capability, maxBytes = MAX_NFO_BYTES) {
      const content = this.readBytes(capability, maxBytes)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/u, '')
      } catch {
        throw new Error('本地文件不是有效的 UTF-8 文本')
      }
    }
  }
}
