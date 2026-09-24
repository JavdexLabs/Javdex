import fs from 'node:fs'
import path from 'node:path'
import { WebError } from '@http/http'
import type { WebCatalogReader } from '@http/catalog'

export function gateCatalogUntilBound(
  inner: WebCatalogReader,
  isBound: () => boolean
): WebCatalogReader {
  const ensureBound = (): void => {
    if (!isBound()) throw new WebError(503, '实例尚未认主，暂不可浏览资料')
  }
  return {
    browse: (query, signal) => {
      ensureBound()
      return inner.browse(query, signal)
    },
    home: (seed, signal) => {
      ensureBound()
      return inner.home(seed, signal)
    },
    collections: (signal) => {
      ensureBound()
      return inner.collections(signal)
    },
    detail: (id) => {
      ensureBound()
      return inner.detail(id)
    },
    image: (id, key, signal, size) => {
      ensureBound()
      return inner.image(id, key, signal, size)
    },
    media: (id, resourceId, download) => {
      ensureBound()
      return inner.media(id, resourceId, download)
    }
  }
}

export function constrainMediaToMounts(
  inner: WebCatalogReader,
  mountRoots: string[]
): WebCatalogReader {
  return {
    ...inner,
    media(id, resourceId, download) {
      const result = inner.media(id, resourceId, download)
      if (!('file' in result) || typeof result.file !== 'string') return result
      if (mountRoots.length === 0) {
        throw new WebError(404, '未配置媒体挂载')
      }
      const file = fs.realpathSync(result.file)
      const allowed = mountRoots.some((root) => {
        const resolved = fs.realpathSync(root)
        return file === resolved || file.startsWith(`${resolved}${path.sep}`)
      })
      if (!allowed) throw new WebError(404, '资源不在已配置的媒体挂载内')
      return result
    }
  }
}
