// Synthetic archives for installer/extraction tests, never imported by production code.
import { gzipSync } from 'node:zlib'
import { Header, type HeaderData } from 'tar'
export function runtimeTar(entries: Array<HeaderData & { contents?: string }>): Buffer {
  return gzipSync(Buffer.concat([...entries.flatMap(entry => {
    const contents = Buffer.from(entry.contents ?? ''), header = new Header({ mode: 0o755, size: contents.length, type: 'File', ...entry })
    header.encode()
    return [header.block!, contents, Buffer.alloc((512 - contents.length % 512) % 512)]
  }), Buffer.alloc(1024)]))
}
