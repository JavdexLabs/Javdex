import path from 'node:path'

const DOT_DOT_SEGMENT = /(?:^|[\\/])(?:\.|%2e)(?:\.|%2e)(?=$|[\\/])/i

export function resolveMediaAssetPath(requestUrl: string, root: string): string | null {
  if (DOT_DOT_SEGMENT.test(requestUrl.replace(/^media:\/\//i, ''))) {
    return null
  }

  const url = new URL(requestUrl)
  const rel = path.normalize(path.join(url.hostname, decodeURIComponent(url.pathname)))
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel)
  const relative = path.relative(rootAbs, abs)

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return abs
}

export function toStoredAssetPath(absPath: string, root: string): string {
  return path.relative(path.resolve(root), path.resolve(absPath)).split(path.sep).join('/')
}
