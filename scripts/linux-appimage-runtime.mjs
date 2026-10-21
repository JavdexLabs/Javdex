import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const appImageRuntime = JSON.parse(readFileSync(new URL('../build/linux-appimage-runtime.json', import.meta.url)))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// Upstream supports changing these fixed-width policy strings without recompiling.
export function configureAppImageRuntime(original) {
  assert.equal(original.length, appImageRuntime.bytes, 'Unexpected AppImage runtime size')
  assert.equal(sha256(original), appImageRuntime.sha256, 'AppImage runtime checksum mismatch')
  const configured = Buffer.from(original)
  for (const [name, before, after] of [
    ['EXTRACT', 3, appImageRuntime.extractPolicy],
    ['UNSHARE', 0, appImageRuntime.unsharePolicy],
    ['CLEANUP', 1, appImageRuntime.cleanupPolicy],
    ['MOUNT', 3, appImageRuntime.mountPolicy]
  ]) {
    const marker = Buffer.from(`URUNTIME_${name}=${before}`)
    const offset = configured.indexOf(marker)
    assert(offset >= 0 && configured.indexOf(marker, offset + 1) === -1, `Unexpected runtime policy ${name}`)
    configured.write(String(after), offset + marker.length - 1, 1, 'ascii')
  }
  return configured
}

export function verifyAppImageRuntimePrefix(prefix) {
  const restored = Buffer.from(prefix)
  for (const [name, configured, original] of [
    ['EXTRACT', appImageRuntime.extractPolicy, 3], ['UNSHARE', appImageRuntime.unsharePolicy, 0]
  ]) {
    const marker = Buffer.from(`URUNTIME_${name}=${configured}`)
    const offset = restored.indexOf(marker)
    assert(offset >= 0 && restored.indexOf(marker, offset + 1) === -1, `Missing configured runtime policy ${name}`)
    restored.write(String(original), offset + marker.length - 1, 1, 'ascii')
  }
  assert.equal(sha256(restored), appImageRuntime.sha256, 'AppImage runtime prefix mismatch')
}

let prepared
export function prepareAutomaticAppImageRuntime() {
  return prepared ??= prepare()
}

async function prepare() {
  const directory = path.resolve('out/linux-appimage-tools', `uruntime-${appImageRuntime.version}`)
  assert(!process.env.APPIMAGE_TOOLS_PATH || process.env.APPIMAGE_TOOLS_PATH === directory,
    'APPIMAGE_TOOLS_PATH conflicts with the pinned automatic-fallback runtime')
  // Obtain the normal pinned compressor and bundled desktop libraries. Only the
  // runtime is replaced, before electron-builder computes offsets/update hashes.
  const { getAppImageTools } = require('app-builder-lib/out/toolsets/linux.js')
  const previousTools = process.env.APPIMAGE_TOOLS_PATH
  delete process.env.APPIMAGE_TOOLS_PATH
  let tools
  try { tools = await getAppImageTools('1.0.3', 1) }
  finally { if (previousTools !== undefined) process.env.APPIMAGE_TOOLS_PATH = previousTools }
  const originalPath = path.resolve('out/linux-appimage-tools', `uruntime-${appImageRuntime.version}.original`)
  mkdirSync(path.dirname(originalPath), { recursive: true })
  if (!existsSync(originalPath)) {
    const response = await fetch(appImageRuntime.url, { signal: AbortSignal.timeout(120000) })
    assert(response.ok, `AppImage runtime download failed: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    configureAppImageRuntime(bytes) // Verify before saving or executing anything.
    const temporary = `${originalPath}.${process.pid}.tmp`
    writeFileSync(temporary, bytes)
    renameSync(temporary, originalPath)
  }
  const configured = configureAppImageRuntime(readFileSync(originalPath))
  // Wrapper symlinks resolve next to appimage-tool, which needs its adjacent
  // host tools. Copy the complete layout and retain relative links. Replacing
  // a previous generated layout also avoids following stale absolute links
  // back into electron-builder's shared cache on a repeated build.
  rmSync(directory, { recursive: true, force: true })
  cpSync(path.dirname(tools.mksquashfs), directory, { recursive: true, verbatimSymlinks: true })
  const runtime = path.join(directory, 'runtimes/runtime-x64')
  writeFileSync(runtime, configured, { mode: 0o755 })
  chmodSync(runtime, 0o755)
  writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({
    ...appImageRuntime, configuredSha256: sha256(configured)
  }, null, 2) + '\n')
  process.env.APPIMAGE_TOOLS_PATH = directory
  return { directory, runtime, mksquashfs: tools.mksquashfs }
}
