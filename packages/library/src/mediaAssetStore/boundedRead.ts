import fs from 'node:fs'

/** Encoded input budget, including the encryption envelope; not a decoded pixel budget. */
export const MAX_ASSET_READ_BYTES = 64 * 1024 * 1024

export class AssetReadTooLargeError extends Error {
  constructor() {
    super('Image asset exceeds the read byte limit')
    this.name = 'AssetReadTooLargeError'
  }
}

export async function readBoundedAssetFile(
  filePath: string, signal?: AbortSignal, maxBytes = MAX_ASSET_READ_BYTES
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid asset byte limit')
  signal?.throwIfAborted()
  const file = await fs.promises.open(filePath, 'r')
  try {
    signal?.throwIfAborted()
    const stat = await file.stat()
    signal?.throwIfAborted()
    if (!stat.isFile()) throw new Error('Asset is not a regular file')
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new AssetReadTooLargeError()
    }
    // Fix allocation to the opened file's initial size: readFile may follow file growth.
    const body = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < body.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(body, offset, Math.min(body.length - offset, 1024 * 1024), offset)
      signal?.throwIfAborted()
      if (bytesRead === 0) throw new Error('Asset changed while reading')
      offset += bytesRead
    }
    const { bytesRead } = await file.read(Buffer.alloc(1), 0, 1, offset)
    signal?.throwIfAborted()
    if (bytesRead !== 0) {
      if (offset === maxBytes) throw new AssetReadTooLargeError()
      throw new Error('Asset changed while reading')
    }
    return body
  } finally {
    await file.close()
  }
}
