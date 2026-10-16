import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { createPinnedFetch } from '@http/pinnedFetch'
import { updaterPairingSchema } from '@shared/serverUpdateTypes'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { openDesktopWorkStore } from '../../desktop/workStore'
import { createRemoteCatalogBackend } from '../../backends/remote/remoteCatalogBackend'
import { clearDesktopDraftStore, configureDesktopDraftStore, desktopAgentDraftRepo } from './desktopDraftStore'
import { AgentMetadataCollection } from './agentMetadataCollection'
import type { CatalogBackend } from '../../application/catalogBackend'

function docker(...args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout || `docker ${args[0]} failed`)
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim()
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

void test('desktop Agent draft transfers to the production Docker server and survives a lost response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-agent-docker-'))
  const userData = path.join(root, 'desktop')
  fs.mkdirSync(userData)
  process.env.JAVDEX_TEST_USER_DATA = userData
  const name = `javdex-agent-h1-${randomUUID()}`
  const port = await freePort()
  const baseUrl = `https://127.0.0.1:${port}`
  const configPath = path.join(root, 'server.json')
  fs.writeFileSync(configPath, JSON.stringify({
    listenHost: '0.0.0.0', port, accessHosts: ['127.0.0.1'],
    dataDir: '/data', imagesDir: '/data/media_assets', staticRoot: '/app/web',
    mediaMounts: { library: '/media' }, web: { username: 'viewer' }
  }))
  const password = 'agent Docker acceptance password'
  const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version as string
  let secret: string | null = null
  let certificateSha256: string | undefined
  let serverId: string | undefined
  const connection = createPinnedFetch(baseUrl, undefined, { verifyCertificate: async fingerprint => {
    if (certificateSha256 && certificateSha256 !== fingerprint) throw new Error('Isolated Agent smoke certificate changed')
    certificateSha256 = fingerprint
  } })
  const credentials = {
    isAvailable: async () => true,
    readWriterSecret: async () => secret,
    writeWriterSecret: async (_catalogId: string, value: string) => { secret = value },
    deleteWriterSecret: async () => { secret = null }
  }
  const createBackend = () => createRemoteCatalogBackend({ baseUrl, appVersion: version, credentials, userDataPath: userData,
    certificateSha256, deviceIdentity: serverId && secret ? { serverId, secret } : undefined })
  const workPath = path.join(userData, 'desktop-work.db')
  let work = openDesktopWorkStore(workPath)
  configureDesktopDraftStore(work.database())
  let backend: CatalogBackend | null = null
  let started = false
  const waitReady = async (): Promise<void> => {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await connection.fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)) {
        ready = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, `Docker server failed to start: ${docker('logs', '--tail', '40', name)}`)
  }
  try {
    const containerImage = process.env.JAVDEX_AGENT_SMOKE_IMAGE || 'javdex-server:smoke'
    docker('image', 'inspect', containerImage)
    docker('create', '--name', name, '-p', `127.0.0.1:${port}:${port}`, '-e', `JAVDEX_WEB_PASSWORD=${password}`,
      '-e', `JAVDEX_PUBLIC_URL=${baseUrl}`, containerImage, 'start', '--config', '/app/agent-smoke.json')
    started = true
    docker('cp', configPath, `${name}:/app/agent-smoke.json`)
    docker('start', name)
    await waitReady()
    const token = docker('exec', name, 'node', '/opt/javdex-manager/index.js', 'token', '--config', '/app/agent-smoke.json')
    assert.match(token, /^[a-f0-9]{64}$/)
    const deviceSecret = randomBytes(32).toString('hex')
    const response = await connection.fetch(`${baseUrl}/connect/v1/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ code: token, claimId: randomUUID(), secretDigest: createHash('sha256').update(deviceSecret).digest('hex'),
        name: 'Isolated Agent smoke', appVersion: version })
    })
    assert.equal(response.status, 200)
    const paired = updaterPairingSchema.parse({ ...await response.json() as object, token: deviceSecret })
    assert.equal(paired.url, baseUrl)
    assert.equal(paired.certificateSha256, certificateSha256)
    serverId = paired.serverId
    secret = paired.token
    backend = createBackend()
    await backend.reconnect()
    assert.equal(backend.session().state, 'available')

    const imported = await backend.videos.importResource({
      libraryId: 1, code: 'H1-101', target: { kind: 'new' },
      url: 'https://example.test/h1-101', kind: 'web', displayName: 'H1 fixture'
    }, { operationId: randomUUID(), expectedVersions: {} }) as { videoId: number }
    const target = { kind: 'video' as const, id: imported.videoId }
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#cc6633' } }).png().toBuffer()
    const [staged] = mediaAssetStore.stageVideoScrapeImages([{
      field: 'cover', position: 0, remoteUrl: 'https://example.test/cover.png', data: png
    }])
    assert.ok(staged)
    const runId = randomUUID()
    work.database().prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'metadata-collector','settled','1','{}','pi','{}','now','now')`).run(runId)
    const draftId = randomUUID()
    const draft = desktopAgentDraftRepo.create({
      id: draftId, runId, target,
      source: { requestedUrl: 'https://example.test/h1-101', displayUrl: 'https://example.test/h1-101' },
      payload: { kind: 'video', result: { code: 'H1-101', title: 'Agent title', coverUrl: staged.remoteUrl },
        observedFields: ['title', 'cover'], explicitlyEmptyFields: [], evidenceRefs: [] },
      resources: [{ ...staged, sha256: createHash('sha256').update(png).digest('hex') }], warnings: []
    }).draft
    const collection = new AgentMetadataCollection()
    collection.bindCatalog(backend)
    assert.equal((await collection.findReady(target))?.id, draftId)
    const serverReady = await backend.agentMetadata.findReady({ target }) as { draft?: unknown }
    assert.equal(serverReady?.draft ?? null, null, 'remote server must not own the desktop Agent draft')
    const review = await collection.plan({ kind: 'video', draftId, expectedRevision: draft.revision,
      fields: ['title', 'cover'], mode: 'replace' })
    assert.equal(review.canApply, true)
    assert.ok(review.previewVersions?.V)

    // A desktop restart must retain the review and locally staged image.
    await backend.dispose()
    backend = null
    work.close()
    clearDesktopDraftStore()
    work = openDesktopWorkStore(workPath)
    configureDesktopDraftStore(work.database())
    backend = createBackend()
    await backend.reconnect()
    assert.equal(backend.session().state, 'available')
    const resumed = new AgentMetadataCollection()
    resumed.bindCatalog(backend)
    assert.equal((await resumed.findReady(target))?.revision, review.revision)

    // The server commits, then the HTTP response is lost before the desktop records it.
    const realApply = backend.agentMetadata.apply
    let dropped = false
    backend.agentMetadata.apply = async (input, context) => {
      const result = await realApply(input, context)
      if (!dropped) {
        dropped = true
        throw new Error('simulated lost response')
      }
      return result
    }
    const firstOperation = randomUUID()
    await assert.rejects(async () => resumed.apply({ draftId, reviewToken: review.token,
      idempotencyKey: firstOperation }), /simulated lost response/)
    assert.equal(desktopAgentDraftRepo.require(draftId).status, 'ready')
    const committed = await backend.queries.getVideo({ scope: { kind: 'all' }, videoId: target.id }) as
      { title: string; cover_path: string; revision: number }
    assert.equal(committed.title, 'Agent title')
    assert.ok(committed.cover_path?.startsWith('covers/'))

    await backend.dispose()
    backend = null
    work.close()
    clearDesktopDraftStore()
    work = openDesktopWorkStore(workPath)
    configureDesktopDraftStore(work.database())
    backend = createBackend()
    await backend.reconnect()
    const retried = new AgentMetadataCollection()
    retried.bindCatalog(backend)
    const outcome = await retried.apply({ draftId, reviewToken: review.token, idempotencyKey: randomUUID() })
    assert.equal(outcome.status, 'applied')
    assert.equal(desktopAgentDraftRepo.require(draftId).status, 'applied')
    assert.equal(fs.existsSync(mediaAssetStore.resolve(staged.stagedPath)), false,
      'applied desktop image staging must be removed')
    const afterRetry = await backend.queries.getVideo({ scope: { kind: 'all' }, videoId: target.id }) as
      { title: string; cover_path: string; revision: number }
    assert.equal(afterRetry.revision, committed.revision, 'retry must not apply twice')
    assert.equal(afterRetry.cover_path, committed.cover_path)
    const receipt = await backend.tasks.getOperation({ operationId: firstOperation })
    assert.equal(receipt?.status, 'applied')

    const login = await connection.fetch(`${baseUrl}/api/login`, { method: 'POST',
      headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Javdex-Client': 'web' },
      body: JSON.stringify({ username: 'viewer', password, remember: true }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const cover = await connection.fetch(`${baseUrl}/api/videos/${target.id}/images/cover`, { headers: { Cookie: cookie } })
    assert.equal(cover.status, 200)
    const image = await sharp(Buffer.from(await cover.arrayBuffer())).metadata()
    assert.deepEqual([image.width, image.height], [32, 24])

    docker('restart', name)
    await waitReady()
    await backend.reconnect()
    assert.equal(backend.session().state, 'available')
    const afterServerRestart = await backend.queries.getVideo({ scope: { kind: 'all' }, videoId: target.id }) as
      { title: string; cover_path: string }
    assert.equal(afterServerRestart.title, 'Agent title')
    assert.equal(afterServerRestart.cover_path, committed.cover_path)

    const discardRunId = randomUUID()
    work.database().prepare(`INSERT INTO agent_runs
      (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
      VALUES (?,'metadata-collector','settled','1','{}','pi','{}','now','now')`).run(discardRunId)
    const discarded = desktopAgentDraftRepo.create({
      id: randomUUID(), runId: discardRunId, target,
      source: { requestedUrl: 'https://example.test/h1-101', displayUrl: 'https://example.test/h1-101' },
      payload: { kind: 'video', result: { code: 'H1-101', title: 'Discard me' },
        observedFields: ['title'], explicitlyEmptyFields: [], evidenceRefs: [] },
      resources: [], warnings: []
    }).draft
    await backend.dispose()
    backend = null
    work.close()
    clearDesktopDraftStore()
    work = openDesktopWorkStore(workPath)
    configureDesktopDraftStore(work.database())
    backend = createBackend()
    await backend.reconnect()
    const finalCollection = new AgentMetadataCollection()
    finalCollection.bindCatalog(backend)
    assert.equal((await finalCollection.findReady(target))?.id, discarded.id)
    await finalCollection.discard({ draftId: discarded.id, expectedRevision: discarded.revision })
    assert.equal(await finalCollection.findReady(target), null)
    assert.equal(desktopAgentDraftRepo.require(discarded.id).status, 'discarded')
    assert.equal((await backend.queries.getVideo({ scope: { kind: 'all' }, videoId: target.id }) as { title: string }).title,
      'Agent title')
    console.log('PASS: H1 Docker desktop draft preview, image transfer, restart, lost-response retry, discard')
  } finally {
    await backend?.dispose()
    await connection.close()
    clearDesktopDraftStore()
    work.close()
    if (started) docker('rm', '-fv', name)
    delete process.env.JAVDEX_TEST_USER_DATA
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})
