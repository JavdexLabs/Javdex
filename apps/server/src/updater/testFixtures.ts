import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { c } from 'tar'
import type { ServerReleaseDescriptor, ServerUpdateManifest } from '@shared/serverUpdateTypes'
import { loadUpdaterConfig } from './config'

export const fixtureServer = `const fs=require('node:fs'),path=require('node:path'),http=require('node:http');const config=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));config.port=Number(process.env.JAVDEX_LISTEN_PORT||config.port);config.accessHosts=[process.env.JAVDEX_ACCESS_HOSTS||config.accessHosts[0]];const f=path.join(config.dataDir,'catalog.fixture.json');const d=JSON.parse(fs.readFileSync(f,'utf8'));const p=JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8'));if(process.env.JAVDEX_UPDATE_JOB){d.schema=20;fs.writeFileSync(f,JSON.stringify(d));if(fs.readFileSync(path.join(__dirname,'webCatalogWorker.js'),'utf8').includes('intentional failure'))process.exit(1)}const s=http.createServer((q,r)=>{if(q.headers.host!==config.accessHosts[0]+":"+config.port){r.writeHead(403);r.end();return}let open=!process.env.JAVDEX_UPDATE_JOB;try{open=open||JSON.parse(fs.readFileSync(path.join(config.dataDir,'server-update-guard.json'),'utf8')).phase==='active'}catch{}if(q.url==='/ready'){r.end('{}');return}r.writeHead(open?200:503,{'Content-Type':'application/json'});r.end(JSON.stringify({appVersion:p.version,schemaVersion:d.schema,identity:{serverId:d.serverId,catalogId:d.catalogId}}))});s.listen(config.port,'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`
export function makeRelease(directory: string, version = '0.8.0', badWorker = false): ServerReleaseDescriptor {
  const sources: Record<string, string> = {
    'index.js': fixtureServer, 'webCatalogWorker.js': badWorker ? 'intentional failure' : '// synthetic worker',
    'web/index.html': '<!doctype html><title>synthetic fixture</title>',
    'package.json': JSON.stringify({ version, type: 'commonjs' }), 'LICENSE': 'Synthetic test fixture', 'NOTICE': 'No real container acceptance',
    'node_modules/better-sqlite3/package.json': '{"main":"index.js"}',
    'node_modules/better-sqlite3/index.js': 'module.exports=class {prepare(){return {get(){return {}}}}close(){}}',
    'node_modules/sharp/package.json': '{"main":"index.js"}',
    'node_modules/sharp/index.js': 'module.exports=()=>({png(){return {toBuffer(){return Promise.resolve(Buffer.alloc(1))}}}})',
    'build-info.json': JSON.stringify({ format: 1, build: 'a'.repeat(40), targetSchema: version === '0.8.0' ? 19 : 20 })
  }
  const files: ServerReleaseDescriptor['files'] = {}
  for (const [name, contents] of Object.entries(sources)) {
    const file = path.join(directory, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
    files[name] = { bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex') }
  }
  const descriptor: ServerReleaseDescriptor = { format: 1, version, build: 'a'.repeat(40), platform: `linux/${process.arch === 'x64' ? 'amd64' : 'arm64'}`, runtime: 'node22-bookworm-v1', targetSchema: version === '0.8.0' ? 19 : 20, files }
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(descriptor))
  return descriptor
}
export async function archiveRelease(directory: string, file: string): Promise<ServerUpdateManifest> {
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8')) as ServerReleaseDescriptor
  await c({ file, cwd: directory, gzip: true, portable: true }, [...Object.keys(descriptor.files), 'release.json'])
  return { format: 1, version: descriptor.version, build: descriptor.build, expiresAt: '2099-01-01T00:00:00.000Z',
    platform: descriptor.platform, runtime: descriptor.runtime, sourceSchemas: [19], targetSchema: descriptor.targetSchema, minUpdaterProtocol: 1,
    archive: { url: 'https://github.com/JavdexLabs/Javdex/releases/download/v0.8.1/fixture.tar.gz', bytes: fs.statSync(file).size,
      unpackedBytes: Object.values(descriptor.files).reduce((sum, value) => sum + value.bytes, fs.statSync(path.join(directory, 'release.json')).size), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') } }
}
export async function fixture(options: { independentImages?: boolean; accessHost?: string } = {}): Promise<{ root: string; config: ReturnType<typeof loadUpdaterConfig> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-managed-test-'))
  const server = createServer()
  const port = await new Promise<number>(resolve => { server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port'); server.close(() => resolve(address.port)) }) })
  const data = path.join(root, 'data')
  fs.mkdirSync(path.join(data, 'media_assets'), { recursive: true })
  const imagesDir = options.independentImages ? path.join(root, 'images') : path.join(data, 'media_assets')
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.writeFileSync(path.join(data, 'catalog.fixture.json'), JSON.stringify({ schema: 19, serverId: randomUUID(), catalogId: randomUUID(), busy: false }))
  const file = path.join(root, 'server.json')
  fs.writeFileSync(file, JSON.stringify({ dataDir: data, imagesDir, port, accessHosts: [options.accessHost ?? '127.0.0.1'] }))
  const seed = path.join(root, 'seed')
  makeRelease(seed)
  const config = loadUpdaterConfig(file, { env: { JAVDEX_RUNTIME_DIR: path.join(root, 'program'), JAVDEX_PUBLIC_URL: 'https://127.0.0.1:8096', JAVDEX_INTERNAL_PORT: String(port), JAVDEX_LISTEN_PORT: port === 8096 ? '8097' : '8096', JAVDEX_SERVER_UID: String(process.getuid?.() ?? 0), JAVDEX_SERVER_GID: String(process.getgid?.() ?? 0), JAVDEX_UPDATE_STOP_TIMEOUT: '1' }, seedDir: seed })
  return { root, config }
}
