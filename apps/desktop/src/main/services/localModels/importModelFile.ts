import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

/** Validate the copied bytes before publishing; the user's original is never moved. */
export async function importModelFile(source: string, destination: string, expected: { bytes: number; sha256: string }): Promise<void> {
  const stat = await fs.stat(source)
  if (!stat.isFile() || stat.size !== expected.bytes) throw new Error('文件大小与所选模型精度不匹配，请检查下载是否完整')
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const stage = `${destination}.import-${randomUUID()}`
  const hash = createHash('sha256')
  let bytes = 0
  try {
    await pipeline(createReadStream(source), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > expected.bytes) { callback(new Error('模型文件大小异常')); return }
        hash.update(chunk); callback(null, chunk)
      }
    }), createWriteStream(stage, { flags: 'wx', mode: 0o600 }))
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('SHA-256 校验失败，文件与所选模型、精度或发布者不匹配')
    await fs.rename(stage, destination)
  } finally { await fs.rm(stage, { force: true }) }
}
