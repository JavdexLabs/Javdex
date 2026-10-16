import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ServerUpdateClient, uploadServerUpdateBundle } from '../packages/http/src/updateClient'
import { writeUpdateBundle } from '../packages/http/src/updateBundle'
import { updaterPairingSchema, type ServerReleaseDescriptor, type ServerUpdateManifest } from '../packages/contracts/src/serverUpdateTypes'
import { SERVER_ENVIRONMENT_VERSION } from '../packages/contracts/src/serverEnvironment'
import { requestBusiness } from '../apps/server/src/updater/businessHttp'
import { waitForUpdateStatus } from './server-updater-smoke-wait'
import { CURRENT_SCHEMA_VERSION } from '../packages/library/src/db/migrations'
import { createPinnedFetch } from '../packages/http/src/pinnedFetch'
import { ManageHttpClient } from '../packages/http/src/manageClient'
import { smokeConnection } from './server-smoke-connection'

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
  const volumes = [dataVolume, programVolume]
  const image = `${name}:runtime`
  const created: string[] = []
  const targetVersion = '0.9.0-beta.1' // Synthetic test release, never published.
  const baselineVersion = '0.9.0-alpha.1' // Current schema, earlier SemVer; not a fake schema-19 release.
  const keys = generateKeyPairSync('ed25519')
  const fingerprint = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  async function freePort(): Promise<number> {
    return new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(() => resolve(address.port)) }) })
  }
  const businessPort = await freePort()
  const configDir = path.join(directory, 'config')
  fs.mkdirSync(configDir, { mode: 0o755 })
  fs.writeFileSync(path.join(configDir, 'server.json'), JSON.stringify({ listenHost: '0.0.0.0', port: 8096, accessHosts: ['127.0.0.1'], dataDir: '/data', imagesDir: '/data/media_assets', mediaMounts: {}, web: { username: 'viewer' } }))
  fs.writeFileSync(path.join(configDir, 'keys.json'), JSON.stringify({ smoke: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
  const base = `http://127.0.0.1:${businessPort}`
  const origin = `https://127.0.0.1:${businessPort}`
  let connection: ReturnType<typeof smokeConnection> | undefined
  const waitReady = async (): Promise<void> => {
    let lastStatus: number | undefined
    for (let i = 0; i < 240; i++) {
      try {
        const response = connection
          ? await connection.fetch(new URL('/ready', origin), { signal: AbortSignal.timeout(1000) })
          : await requestBusiness(new URL('/ready', base), '127.0.0.1:8096', { timeoutMs: 1000 })
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
    docker(['rm', source]); created.splice(created.indexOf(source), 1)

    const arch = process.arch === 'x64' ? 'amd64' : 'arm64'
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
    const imageDescriptor = JSON.parse(fs.readFileSync(path.join(good, 'release.json'), 'utf8')) as ServerReleaseDescriptor
    assert.equal(imageDescriptor.environmentVersion, SERVER_ENVIRONMENT_VERSION, 'image metadata must declare the baked environment version')
    docker(['rm', artifact]); created.splice(created.indexOf(artifact), 1)
    // The published 0.8.0 image supplies real schema-19 data above. The managed
    // baseline uses this source's unified pairing APIs with a synthetic version;
    // the old binary itself has no unified device-pairing protocol.
    const seed = path.join(directory, 'baseline-release')
    fs.cpSync(good, seed, { recursive: true })
    const baselinePackage = path.join(seed, 'package.json')
    fs.writeFileSync(baselinePackage, JSON.stringify({ ...JSON.parse(fs.readFileSync(baselinePackage, 'utf8')), version: baselineVersion }))
    execFileSync(process.execPath, ['scripts/server-release-package.mjs', 'metadata', seed, `linux/${arch}`], { stdio: 'inherit' })
    fs.chmodSync(seed, 0o755)
    connection = smokeConnection(origin)


    docker(['run', '--detach', '--name', name, '--label', `javdex.update-test=${name}`, '--stop-timeout', '150', '-p', `127.0.0.1:${businessPort}:8096`, '-v', `${dataVolume}:/data`, '-v', `${programVolume}:/program`, '-v', `${configDir}:/config:ro`, '-v', `${seed}:/seed:ro`, '-e', 'JAVDEX_SERVER_SEED_DIR=/seed', '-e', 'JAVDEX_WEB_PASSWORD=isolated-smoke-password', '-e', 'JAVDEX_UPDATE_KEYS_FILE=/config/keys.json', '-e', `JAVDEX_PUBLIC_URL=${origin}`, image, 'start', '--config', '/config/server.json'])
    created.push(name)
    await waitReady()
    // Query the image itself before a device grant or matching-version header.
    const environment = await connection.fetch(new URL('/runtime/v1/info', origin))
    assert.equal(environment.status, 200)
    assert.equal(environment.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await environment.json(), { format: 1, environmentVersion: SERVER_ENVIRONMENT_VERSION,
      runtimeId: 'node22-bookworm-v1', platform: `linux/${arch}` })
    const bundle = docker(['exec', name, 'node', '/opt/javdex-manager/index.js', 'token', '--config', '/config/server.json']).trim()
    const secret = randomBytes(32).toString('hex')
    const paired = await connection.claim(bundle, baselineVersion, secret)
    const client = new ServerUpdateClient(updaterPairingSchema.parse({ ...paired, token: secret }))
    const initial = await waitForUpdateStatus(() => client.control('status'))
    assert.equal(initial.currentVersion, baselineVersion); assert.equal(initial.serverId, original.server_id)
    // A successful install keeps this fixture available for the image-upgrade checks.
    {
      const kind = 'good'
      const closure = path.join(directory, kind)
      fs.cpSync(good, closure, { recursive: true })
      const archive = path.join(directory, `${kind}.tar.gz`)
      execFileSync(process.execPath, ['scripts/server-release-package.mjs', 'archive', closure, archive], { stdio: 'inherit' })
      const payloadDescriptor = JSON.parse(dockerArchiveMetadata(archive, directory)) as ServerReleaseDescriptor
      assert.equal(payloadDescriptor.environmentVersion, SERVER_ENVIRONMENT_VERSION)
      const manifest: ServerUpdateManifest = { format: 1, version: targetVersion, build: payloadDescriptor.build, expiresAt: new Date(Date.now() + 86400_000).toISOString(), platform: `linux/${arch}`, sourceSchemas: [CURRENT_SCHEMA_VERSION], targetSchema: CURRENT_SCHEMA_VERSION, minUpdaterProtocol: 1, runtime: 'node22-bookworm-v1', environmentVersion: SERVER_ENVIRONMENT_VERSION, archive: { url: `https://github.com/JavdexLabs/Javdex/releases/download/v${targetVersion}/${kind}.javdex-update`, bytes: fs.statSync(archive).size, unpackedBytes: Object.values(payloadDescriptor.files).reduce((sum, value) => sum + value.bytes, Buffer.byteLength(JSON.stringify(payloadDescriptor)) + 1), sha256: fingerprint(archive) } }
      const payload = JSON.stringify(manifest)
      const incompatiblePayload = JSON.stringify({ ...manifest, environmentVersion: SERVER_ENVIRONMENT_VERSION + 1 })
      await assert.rejects(client.import({ keyId: 'smoke', payload: incompatiblePayload,
        signature: sign(null, Buffer.from(incompatiblePayload), keys.privateKey).toString('base64') }, targetVersion), /需要升级服务端Docker镜像/)
      assert.equal((await client.control('status')).job, null, 'a signed incompatible environment cannot create a job or accept archive bytes')
      const bundle = path.join(directory, `${kind}.javdex-update`)
      await writeUpdateBundle(archive, bundle, { keyId: 'smoke', payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
      const fd = fs.openSync(bundle, 'r')
      let state
      try { state = await uploadServerUpdateBundle(client, fd, targetVersion) } finally { fs.closeSync(fd) }
      assert.equal(state.job?.phase, 'prepared')
      await client.control('install', state.job!.id, { targetVersion })
      for (let i = 0; i < 480; i++) {
        try {
          state = await client.control('status')
          if (['complete', 'failed', 'recoveryRequired'].includes(state.job?.phase ?? '')) break
        } catch { /* The same pinned certificate survives container restart. */ }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.equal(state.job?.phase, 'complete', state.job?.message ?? undefined)
      assert.equal(state.serverId, original.server_id); assert.equal(state.catalogId, original.catalog_id)
      assert.equal(docker(['ps', '--filter', `label=javdex.update-test=${name}`, '--format', '{{.Names}}']), name, 'updates must not start another container')
      const identity = JSON.parse(docker(['exec', name, 'node', '-e', "const D=require('/app/node_modules/better-sqlite3');const d=new D('/data/library.db',{readonly:true});console.log(JSON.stringify({schema:d.pragma('user_version',{simple:true}),lists:d.prepare(\"SELECT count(*) AS n FROM playlists WHERE name='preserved user list'\").get().n}));d.close();"])) as { schema: number; lists: number }
      assert.equal(identity.schema, CURRENT_SCHEMA_VERSION); assert.equal(identity.lists, 1)
    }
    // Failed installs no longer roll back. Each fault therefore uses its own
    // disposable container and volumes instead of reusing a migrated library.
    for (const kind of ['worker-failure', 'interrupted'] as const) {
      const faultName = `${name}-${kind}`
      const faultData = `${faultName}-data`
      const faultProgram = `${faultName}-program`
      volumes.push(faultData, faultProgram)
      docker(['volume', 'create', faultData]); docker(['volume', 'create', faultProgram])
      const faultPort = await freePort()
      const faultOrigin = `https://127.0.0.1:${faultPort}`
      const faultConnection = smokeConnection(faultOrigin)
      try {
        docker(['run', '--detach', '--name', faultName, '--stop-timeout', '150', '-p', `127.0.0.1:${faultPort}:8096`,
          '-v', `${faultData}:/data`, '-v', `${faultProgram}:/program`, '-v', `${configDir}:/config:ro`, '-v', `${seed}:/seed:ro`,
          '-e', 'JAVDEX_SERVER_SEED_DIR=/seed', '-e', 'JAVDEX_WEB_PASSWORD=isolated-smoke-password',
          '-e', 'JAVDEX_UPDATE_KEYS_FILE=/config/keys.json', '-e', `JAVDEX_PUBLIC_URL=${faultOrigin}`, image, 'start', '--config', '/config/server.json'])
        created.push(faultName)
        let ready = false
        for (let i = 0; i < 240; i++) {
          try { if ((await faultConnection.fetch(new URL('/ready', faultOrigin), { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break } } catch { /* Wait for startup. */ }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        assert.equal(ready, true, 'isolated failure baseline must start')
        const token = docker(['exec', faultName, 'node', '/opt/javdex-manager/index.js', 'token', '--config', '/config/server.json'])
        const secret = randomBytes(32).toString('hex')
        const paired = await faultConnection.claim(token, baselineVersion, secret)
        const client = new ServerUpdateClient(updaterPairingSchema.parse({ ...paired, token: secret }))
        const baseline = await client.control('status')
        docker(['exec', faultName, 'node', '-e', "require('node:fs').writeFileSync('/data/preserved-smoke-data','must survive failed upgrade')"])
        const closure = path.join(directory, kind)
        fs.cpSync(good, closure, { recursive: true })
        fs.writeFileSync(path.join(closure, 'webCatalogWorker.js'), kind === 'worker-failure'
          ? "throw new Error('intentional post-migration failure');" : 'setInterval(()=>{},1000);')
        const archive = path.join(directory, `${kind}.tar.gz`)
        execFileSync(process.execPath, ['scripts/server-release-package.mjs', 'archive', closure, archive], { stdio: 'inherit' })
        const descriptor = JSON.parse(dockerArchiveMetadata(archive, directory)) as ServerReleaseDescriptor
        assert.equal(descriptor.environmentVersion, SERVER_ENVIRONMENT_VERSION)
        const manifest: ServerUpdateManifest = { format: 1, version: targetVersion, build: descriptor.build, expiresAt: new Date(Date.now() + 86400_000).toISOString(), platform: `linux/${arch}`, sourceSchemas: [CURRENT_SCHEMA_VERSION], targetSchema: CURRENT_SCHEMA_VERSION, minUpdaterProtocol: 1, runtime: 'node22-bookworm-v1', environmentVersion: SERVER_ENVIRONMENT_VERSION, archive: { url: `https://github.com/JavdexLabs/Javdex/releases/download/v${targetVersion}/${kind}.javdex-update`, bytes: fs.statSync(archive).size, unpackedBytes: Object.values(descriptor.files).reduce((sum, file) => sum + file.bytes, Buffer.byteLength(JSON.stringify(descriptor)) + 1), sha256: fingerprint(archive) } }
        const payload = JSON.stringify(manifest)
        const file = path.join(directory, `${kind}.javdex-update`)
        await writeUpdateBundle(archive, file, { keyId: 'smoke', payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
        const fd = fs.openSync(file, 'r')
        let state
        try { state = await uploadServerUpdateBundle(client, fd, targetVersion) } finally { fs.closeSync(fd) }
        await client.control('install', state.job!.id, { targetVersion })
        let interrupted = false
        for (let i = 0; i < 480; i++) {
          try {
            state = await client.control('status')
            if (kind === 'interrupted' && !interrupted && state.job?.phase === 'verifying') {
              docker(['kill', '--signal', 'KILL', faultName]); docker(['start', faultName]); interrupted = true
            }
            if (state.job?.phase === 'recoveryRequired') break
          } catch { /* Pinned identity survives the intentional container interruption. */ }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        assert.equal(state.job?.phase, 'recoveryRequired', state.job?.message ?? undefined)
        if (kind === 'interrupted') assert.equal(interrupted, true)
        assert.equal(state.serverId, baseline.serverId); assert.equal(state.catalogId, baseline.catalogId)
        assert.equal(docker(['exec', faultName, 'node', '-e', "console.log(require('node:fs').readFileSync('/data/preserved-smoke-data','utf8'))"]), 'must survive failed upgrade')
        await assert.rejects(client.control('prepare', undefined, { targetVersion }), /人工恢复/)
        docker(['restart', '--time', '150', faultName])
        assert.equal((await waitForUpdateStatus(() => client.control('status'))).job?.phase, 'recoveryRequired', 'restart cannot automatically reopen migrated data')
      } finally { await faultConnection.close() }
    }
    docker(['restart', '--time', '150', name])
    await waitReady()
    assert.equal((await waitForUpdateStatus(() => client.control('status'))).currentVersion, targetVersion, 'seed cannot overwrite a persistently selected release')
    const uid = docker(['exec', name, 'node', '-e', "const fs=require('node:fs');for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const cmd=fs.readFileSync('/proc/'+p+'/cmdline','utf8');const script=cmd.split('\\0')[1];if(script?.startsWith('/program/releases/')&&script.endsWith('/index.js'))console.log(fs.readFileSync('/proc/'+p+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1])}catch{}}"])
    assert.equal(uid, '1000', 'business process must remain non-root')
    // Replace the actual image, keeping both volumes and pinned credentials.
    // No upload or install request may be needed to adopt its newer business.
    product.version = '0.9.0'
    fs.writeFileSync(productFile, JSON.stringify(product))
    execFileSync('docker', ['build', '-t', image, context], { stdio: 'inherit' })
    const recreate = async (oldSeed: boolean): Promise<void> => {
      docker(['stop', '--time', '150', name]); docker(['rm', name]); created.splice(created.indexOf(name), 1)
      docker(['run', '--detach', '--name', name, '--label', `javdex.update-test=${name}`, '--stop-timeout', '150',
        '-p', `127.0.0.1:${businessPort}:8096`,
        '-v', `${dataVolume}:/data`, '-v', `${programVolume}:/program`, '-v', `${configDir}:/config:ro`,
        ...(oldSeed ? ['-v', `${seed}:/seed:ro`, '-e', 'JAVDEX_SERVER_SEED_DIR=/seed'] : []),
        '-e', 'JAVDEX_WEB_PASSWORD=isolated-smoke-password', '-e', 'JAVDEX_UPDATE_KEYS_FILE=/config/keys.json',
        '-e', `JAVDEX_PUBLIC_URL=${origin}`, image, 'start', '--config', '/config/server.json'])
      created.push(name)
      await waitReady()
    }
    await recreate(false)
    let imageState = await waitForUpdateStatus(() => client.control('status'))
    for (let i = 0; i < 480 && imageState.job?.phase !== 'complete' && !['failed', 'recoveryRequired'].includes(imageState.job?.phase ?? ''); i++) {
      await new Promise(resolve => setTimeout(resolve, 250))
      imageState = await client.control('status')
    }
    assert.equal(imageState.currentVersion, '0.9.0')
    assert.equal(imageState.job?.phase, 'complete', imageState.job?.message ?? undefined)
    assert.equal(imageState.serverId, original.server_id); assert.equal(imageState.catalogId, original.catalog_id)
    const imageJob = imageState.job.id
    docker(['restart', '--time', '150', name]); await waitReady()
    assert.equal((await waitForUpdateStatus(() => client.control('status'))).job?.id, imageJob, 'same image must not reinstall')
    await recreate(true)
    const retained = await waitForUpdateStatus(() => client.control('status'))
    assert.equal(retained.currentVersion, '0.9.0', 'older image seed must not downgrade the program volume')
    assert.equal(retained.job?.id, imageJob)

    // Exercise the actual root gateway and non-root business in one container,
    // with additional devices and selective revocation.
    docker(['stop', '--time', '150', name]); docker(['rm', name]); created.splice(created.indexOf(name), 1)
    const unifiedOrigin = `https://127.0.0.1:${businessPort}`
    docker(['run', '--detach', '--name', name, '--label', `javdex.update-test=${name}`, '--stop-timeout', '150',
      '-p', `127.0.0.1:${businessPort}:8096`, '-v', `${dataVolume}:/data`, '-v', `${programVolume}:/program`, '-v', `${configDir}:/config:ro`,
      '-e', 'JAVDEX_WEB_PASSWORD=isolated-smoke-password', '-e', 'JAVDEX_UPDATE_KEYS_FILE=/config/keys.json',
      '-e', `JAVDEX_PUBLIC_URL=${unifiedOrigin}`, image, 'start', '--config', '/config/server.json'])
    created.push(name)
    let unifiedReady = false
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8098/ready',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"])
        unifiedReady = true
        break
      } catch { await new Promise(resolve => setTimeout(resolve, 250)) }
    }
    assert.equal(unifiedReady, true, 'unified business must become ready on the private internal listener')
    const devices: { manage: ManageHttpClient; update: ServerUpdateClient }[] = []
    try {
      for (let index = 0; index < 2; index++) {
        // Each grant is consumed before issuing the next device's grant.
        const bundle = docker(['exec', name, 'node', '/opt/javdex-manager/index.js', 'token', '--config', '/config/server.json']).trim()
        assert.match(bundle, /^[a-f0-9]{64}$/)
        let certificateSha256: string | undefined
        const transport = createPinnedFetch(unifiedOrigin, undefined, { verifyCertificate: async fingerprint => { certificateSha256 = fingerprint } })
        const secret = randomBytes(32).toString('hex')
        try {
          const response = await transport.fetch(new URL('/connect/v1/claim', unifiedOrigin), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
            body: JSON.stringify({ code: bundle, claimId: randomUUID(), secretDigest: createHash('sha256').update(secret).digest('hex'), name: `Smoke device ${index}`, appVersion: '0.9.0' })
          })
          const claimed = await response.json()
          assert.equal(response.status, 200, JSON.stringify(claimed))
          const paired = updaterPairingSchema.parse({ ...claimed as object, token: secret })
          assert.equal(paired.certificateSha256, certificateSha256)
          const manage = new ManageHttpClient({ baseUrl: paired.url, appVersion: '0.9.0', certificateSha256: paired.certificateSha256 })
          const update = new ServerUpdateClient(paired)
          devices.push({ manage, update })
          assert.equal((await update.control('status')).currentVersion, '0.9.0')
        } finally { await transport.close() }
      }
      const first = devices[0]
      const hello = await first.manage.post('handshake.get', { input: {} }, { sendAppVersion: false }) as { identity: { serverId: string; catalogId: string }; writerEpoch: number }
      assert.equal(hello.identity.serverId, original.server_id)
      assert.equal(hello.identity.catalogId, original.catalog_id)
      const envelope = { ...hello.identity, writerEpoch: hello.writerEpoch, input: {} }
      const trusted = await first.manage.post('devices.list', envelope, { bearer: first.update.pairing.token }) as { id: string; current: boolean; name: string }[]
      assert.equal(trusted.length, 3)
      const other = trusted.find(device => device.name === 'Smoke device 1')!
      await first.manage.post('devices.revoke', { ...envelope, operationId: randomUUID(), expectedVersions: {}, input: { deviceId: other.id } }, { bearer: first.update.pairing.token })
      await assert.rejects(devices[1].update.control('status'), /授权/)
      assert.equal((await first.update.control('status')).currentVersion, '0.9.0', 'revoking another device preserves update authorization')
      const refreshed = await first.manage.post('handshake.get', { input: {} }, { sendAppVersion: false }) as typeof hello
      await assert.rejects(devices[1].manage.post('writer.status', { ...refreshed.identity, writerEpoch: refreshed.writerEpoch, input: {} }, { bearer: devices[1].update.pairing.token }), { code: 'AUTH_REQUIRED' })
      await first.manage.post('writer.status', { ...refreshed.identity, writerEpoch: refreshed.writerEpoch, input: {} }, { bearer: first.update.pairing.token })
    } finally { await Promise.all(devices.map(device => device.manage.close())) }
    console.log('Single-container acceptance passed: signed update without library copies, failed/interrupted install maintenance, image replacement upgrade, same/older seed retention, unified pinned HTTPS pairing, selective device revocation, native closure, persistent identity and non-root business.')
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
    await connection?.close()
    for (const container of created.reverse()) try { docker(['rm', '--force', container]) } catch { /* Owned test container only. */ }
    for (const volume of volumes) try { docker(['volume', 'rm', volume]) } catch { /* Preserve evidence if cleanup cannot complete. */ }
    try { docker(['image', 'rm', image]) } catch { /* Owned synthetic image only. */ }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })

function dockerArchiveMetadata(archive: string, root: string): string {
  return execFileSync('tar', ['-xOzf', archive, 'release.json'], { encoding: 'utf8', cwd: root, maxBuffer: 4 * 1024 ** 2 })
}
