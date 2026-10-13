import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ServerUpdateClient } from '../packages/http/src/updateClient'
import { updaterPairingSchema, type ServerReleaseDescriptor, type ServerUpdateManifest } from '../packages/contracts/src/serverUpdateTypes'
import { requestBusiness } from '../apps/server/src/updater/businessHttp'

async function main(): Promise<void> {
  // Real Linux images, real native modules and published schema 19. No mocked Docker.
  if (process.platform !== 'linux') throw new Error('Single-container acceptance requires Linux Docker')
  for (const file of ['out/server/index.js', 'out/updater/index.js', 'out/updater/package.mjs']) if (!fs.existsSync(file)) throw new Error('Run server:build first')
  const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 8 * 1024 ** 2 }).trim()
  docker(['version']); docker(['info'])
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-one-container-smoke-'))
  const name = `javdex-single-${randomUUID()}`
  const dataVolume = `${name}-data`
  const programVolume = `${name}-program`
  const image = `${name}:runtime`
  const created: string[] = []
  const targetVersion = '0.9.0-beta.1' // Synthetic test release, never published.
  const keys = generateKeyPairSync('ed25519')
  const fingerprint = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  async function freePort(): Promise<number> {
    return new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(() => resolve(address.port)) }) })
  }
  const businessPort = await freePort()
  const updatePort = await freePort()
  const configDir = path.join(directory, 'config')
  fs.mkdirSync(configDir, { mode: 0o755 })
  fs.writeFileSync(path.join(configDir, 'server.json'), JSON.stringify({ listenHost: '0.0.0.0', port: 8096, accessHosts: ['127.0.0.1'], dataDir: '/data', imagesDir: '/data/media_assets', mediaMounts: {}, web: { username: 'viewer' } }))
  fs.writeFileSync(path.join(configDir, 'keys.json'), JSON.stringify({ smoke: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
  const base = `http://127.0.0.1:${businessPort}`
  const waitReady = async (): Promise<void> => {
    let lastStatus: number | undefined
    for (let i = 0; i < 240; i++) {
      try {
        const response = await requestBusiness(new URL('/ready', base), '127.0.0.1:8096', { timeoutMs: 1000 })
        lastStatus = response.status
        if (response.ok) return
      } catch { /* Waiting for actual startup. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Isolated container did not become ready (last HTTP status: ${lastStatus ?? 'unreachable'})`)
  }
  try {
    docker(['volume', 'create', dataVolume]); docker(['volume', 'create', programVolume])
    docker(['pull', 'ghcr.io/javdexlabs/javdex-server:0.8.0'])
    const source = `${name}-published`
    docker(['run', '--detach', '--name', source, '--label', `javdex.update-test=${name}`, '-p', `127.0.0.1:${businessPort}:8096`, '-v', `${dataVolume}:/data`, '-v', `${configDir}:/config:ro`, '-e', 'JAVDEX_WEB_PASSWORD=isolated-smoke-password', 'ghcr.io/javdexlabs/javdex-server:0.8.0', 'start', '--config', '/config/server.json'])
    created.push(source)
    await waitReady()
    const original = JSON.parse(docker(['exec', source, 'node', '-e', "const D=require('better-sqlite3');const d=new D('/data/library.db');const id=d.prepare('SELECT server_id,catalog_id FROM catalog_identity WHERE id=1').get();d.prepare('INSERT INTO playlists(name) VALUES (?)').run('preserved user list');console.log(JSON.stringify({...id,schema:d.pragma('user_version',{simple:true})}));d.close();"])) as { server_id: string; catalog_id: string; schema: number }
    assert.equal(original.schema, 19)
    docker(['stop', '--time', '120', source])
    const seed = path.join(directory, 'published-release')
    fs.mkdirSync(seed)
    docker(['cp', `${source}:/app/.`, seed])
    // The old image did not include release metadata. This is a test-only repack.
    for (const file of ['LICENSE', 'NOTICE']) if (!fs.existsSync(path.join(seed, file))) fs.copyFileSync(file, path.join(seed, file))
    fs.writeFileSync(path.join(seed, 'build-info.json'), JSON.stringify({ format: 1, build: 'b'.repeat(40), targetSchema: 19 }))
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64'
    execFileSync(process.execPath, ['scripts/server-release-package.mjs', 'metadata', seed, `linux/${arch}`], { stdio: 'inherit' })
    fs.chmodSync(seed, 0o755)
    docker(['rm', source]); created.splice(created.indexOf(source), 1)

    const context = path.join(directory, 'context')
    fs.mkdirSync(context)
    fs.cpSync('out/server', path.join(context, 'out/server'), { recursive: true })
    fs.cpSync('out/updater', path.join(context, 'out/updater'), { recursive: true })
    fs.copyFileSync('Dockerfile', path.join(context, 'Dockerfile'))
    const productFile = path.join(context, 'out/server/package.json')
    const product = JSON.parse(fs.readFileSync(productFile, 'utf8')) as { version: string }
    product.version = targetVersion
    fs.writeFileSync(productFile, JSON.stringify(product))
    execFileSync('docker', ['build', '-t', image, context], { stdio: 'inherit' })
    const artifact = `${name}-artifact`
    docker(['create', '--name', artifact, image]); created.push(artifact)
    const good = path.join(directory, 'good-release')
    fs.mkdirSync(good)
    docker(['cp', `${artifact}:/app/.`, good])
    docker(['rm', artifact]); created.splice(created.indexOf(artifact), 1)

    docker(['run', '--detach', '--name', name, '--label', `javdex.update-test=${name}`, '--stop-timeout', '150', '-p', `127.0.0.1:${businessPort}:8096`, '-p', `127.0.0.1:${updatePort}:8097`, '-v', `${dataVolume}:/data`, '-v', `${programVolume}:/program`, '-v', `${configDir}:/config:ro`, '-v', `${seed}:/seed:ro`, '-e', 'JAVDEX_SERVER_SEED_DIR=/seed', '-e', 'JAVDEX_WEB_PASSWORD=isolated-smoke-password', '-e', 'JAVDEX_UPDATE_KEYS_FILE=/config/keys.json', '-e', `JAVDEX_UPDATE_PUBLIC_URL=https://127.0.0.1:${updatePort}`, image, 'start', '--config', '/config/server.json'])
    created.push(name)
    await waitReady()
    const pairing = updaterPairingSchema.parse(JSON.parse(docker(['exec', name, 'node', '/opt/javdex-manager/index.js', 'pair', '--config', '/config/server.json'])))
    const client = new ServerUpdateClient(pairing)
    const initial = await client.control('status')
    assert.equal(initial.currentVersion, '0.8.0'); assert.equal(initial.serverId, original.server_id)
    for (const kind of ['worker-failure', 'interrupted', 'good'] as const) {
      const closure = path.join(directory, kind)
      fs.cpSync(good, closure, { recursive: true })
      if (kind !== 'good') fs.writeFileSync(path.join(closure, 'webCatalogWorker.js'), `import {createRequire} from 'node:module';const D=createRequire(import.meta.url)('better-sqlite3');const d=new D('/data/library.db',{readonly:true});console.log('UPDATER_TEST_SCHEMA='+d.pragma('user_version',{simple:true}));d.close();${kind === 'worker-failure' ? "throw new Error('intentional post-migration failure');" : 'setInterval(()=>{},1000);'}`)
      const archive = path.join(directory, `${kind}.tar.gz`)
      execFileSync(process.execPath, ['scripts/server-release-package.mjs', 'archive', closure, archive], { stdio: 'inherit' })
      const payloadDescriptor = JSON.parse(dockerArchiveMetadata(archive, directory)) as ServerReleaseDescriptor
      const manifest: ServerUpdateManifest = { format: 1, version: targetVersion, build: payloadDescriptor.build, expiresAt: new Date(Date.now() + 86400_000).toISOString(), platform: `linux/${arch}`, sourceSchemas: [19], targetSchema: 20, minUpdaterProtocol: 1, runtime: 'node22-bookworm-v1', archive: { url: `https://github.com/JavdexLabs/Javdex/releases/download/v${targetVersion}/${kind}.tar.gz`, bytes: fs.statSync(archive).size, unpackedBytes: Object.values(payloadDescriptor.files).reduce((sum, value) => sum + value.bytes, Buffer.byteLength(JSON.stringify(payloadDescriptor)) + 1), sha256: fingerprint(archive) } }
      const payload = JSON.stringify(manifest)
      let state = await client.import({ keyId: 'smoke', payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
      for await (const chunk of fs.createReadStream(archive, { highWaterMark: 8 * 1024 ** 2 })) state = await client.upload(state.job!.id, state.job!.receivedBytes, Buffer.from(chunk))
      assert.equal(state.job?.phase, 'prepared')
      await client.control('install', state.job!.id)
      let interrupted = false
      for (let i = 0; i < 480; i++) {
        try {
          state = await client.control('status')
          if (kind === 'interrupted' && !interrupted && state.job?.phase === 'verifying') {
            docker(['kill', '--signal', 'KILL', name]); docker(['start', name]); interrupted = true
          }
          if (['complete', 'restored', 'recoveryRequired'].includes(state.job?.phase ?? '')) break
        } catch { /* The same pinned certificate survives container restart. */ }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.equal(state.job?.phase, kind === 'good' ? 'complete' : 'restored', state.job?.message ?? undefined)
      if (kind === 'interrupted') assert.equal(interrupted, true, 'interruption acceptance must actually kill and restart the container during verification')
      assert.match(docker(['logs', name]), /UPDATER_TEST_SCHEMA=20/)
      assert.equal(state.serverId, original.server_id); assert.equal(state.catalogId, original.catalog_id)
      assert.equal(docker(['ps', '--filter', `label=javdex.update-test=${name}`, '--format', '{{.Names}}']), name, 'updates must not start another container')
      const identity = JSON.parse(docker(['exec', name, 'node', '-e', "const D=require('/app/node_modules/better-sqlite3');const d=new D('/data/library.db',{readonly:true});console.log(JSON.stringify({schema:d.pragma('user_version',{simple:true}),lists:d.prepare(\"SELECT count(*) AS n FROM playlists WHERE name='preserved user list'\").get().n}));d.close();"])) as { schema: number; lists: number }
      assert.equal(identity.schema, kind === 'good' ? 20 : 19); assert.equal(identity.lists, 1)
    }
    docker(['restart', '--time', '150', name])
    await waitReady()
    assert.equal((await client.control('status')).currentVersion, targetVersion, 'seed cannot overwrite a persistently selected release')
    const uid = docker(['exec', name, 'node', '-e', "const fs=require('node:fs');for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const cmd=fs.readFileSync('/proc/'+p+'/cmdline','utf8');if(cmd.includes('/program/releases/')&&cmd.includes('/index.js'))console.log(fs.readFileSync('/proc/'+p+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1])}catch{}}"])
    assert.equal(uid, '1000', 'business process must remain non-root')
    console.log('Single-container acceptance passed: real schema 19 upgrade to a signed beta, native closure, worker-failure and restart recovery, one running container, non-root business and persistent selection.')
  } catch (error) {
    // Preserve bounded startup evidence before removing the owned test containers.
    for (const container of created) {
      console.error(`[updater-smoke] Container evidence for ${container}`)
      for (const args of [['inspect', '--format', '{{json .State}}', container], ['logs', '--tail', '80', container]]) {
        try { execFileSync('docker', args, { stdio: 'inherit', timeout: 5000 }) } catch { /* Keep the original acceptance failure. */ }
      }
    }
    throw error
  } finally {
    for (const container of created.reverse()) try { docker(['rm', '--force', container]) } catch { /* Owned test container only. */ }
    for (const volume of [dataVolume, programVolume]) try { docker(['volume', 'rm', volume]) } catch { /* Preserve evidence if cleanup cannot complete. */ }
    try { docker(['image', 'rm', image]) } catch { /* Owned synthetic image only. */ }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })

function dockerArchiveMetadata(archive: string, root: string): string {
  return execFileSync('tar', ['-xOzf', archive, 'release.json'], { encoding: 'utf8', cwd: root, maxBuffer: 4 * 1024 ** 2 })
}
