import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assertOriginalPublication, replacePublication, replacementContext } from './release-replacement.mjs'
import { replacementApi } from './release-replacement-api.mjs'
const original = JSON.parse(fs.readFileSync(new URL('./fixtures/replacement-0.9.0-original.json', import.meta.url), 'utf8'))
const candidate = '1234567890123456789012345678901234567890'

test('only the captured original 0.9.0 publication can enter a controlled replacement', () => {
  assert.doesNotThrow(() => assertOriginalPublication(original, candidate))
  assert.throws(() => assertOriginalPublication(original, original.release.target_commitish), /different source/)
})
test('changed Release identity, visibility, immutability or notes stop replacement', () => {
  for (const change of [{ id: 999 }, { draft: true }, { prerelease: true }, { immutable: true },
    { target_commitish: 'f'.repeat(40) }, { body: original.release.body + '\nChanged by owner' }]) {
    const observed = structuredClone(original)
    Object.assign(observed.release, change)
    assert.throws(() => assertOriginalPublication(observed, candidate), /original publication/)
  }
})
test('changed, missing or additional old assets stop replacement before any write', () => {
  for (const change of ['size', 'digest', 'extra', 'missing']) {
    const observed = structuredClone(original)
    if (change === 'size') observed.release.assets[0].size += 1
    if (change === 'digest') observed.release.assets[0].digest = 'sha256:' + '0'.repeat(64)
    if (change === 'extra') observed.release.assets.push({ id: 999, name: 'unrecognized.zip' })
    if (change === 'missing') observed.release.assets.pop()
    assert.throws(() => assertOriginalPublication(observed, candidate), /original publication/)
  }
})
test('a changed tag or image digest cannot be treated as the approved original', () => {
  const observed = structuredClone(original)
  observed.tag.sha = 'f'.repeat(40)
  assert.throws(() => assertOriginalPublication(observed, candidate), /original publication/)
  observed.tag = original.tag
  observed.imageDigest = 'sha256:' + 'f'.repeat(64)
  assert.throws(() => assertOriginalPublication(observed, candidate), /original publication/)
})

function publicationPort(failure) {
  const state = { tag: 'old', image: 'old', release: 'old', backups: false, staged: false }
  const calls = []
  const port = {
    async observeOriginal() { calls.push('observe'); return structuredClone(original) },
    async stage() { calls.push('stage'); state.staged = true },
    async backup() { calls.push('backup'); state.backups = true },
    async archiveOriginal() { calls.push('archive'); state.release = 'hidden'; if (failure === 'archive') throw Error('injected failure') },
    async moveTag() { calls.push('tag'); state.tag = 'new'; if (failure === 'tag') throw Error('injected failure') },
    async moveImage() { calls.push('image'); state.image = 'new'; if (failure === 'image') throw Error('injected failure') },
    async publish() { calls.push('publish'); state.release = 'new'; if (failure === 'publish') throw Error('injected failure') },
    async verify() { calls.push('verify'); if (failure === 'verify') throw Error('injected failure') },
    async rollback() { calls.push('rollback'); Object.assign(state, { tag: 'old', image: 'old', release: 'old' }) }
  }
  return { state, calls, port }
}
test('complete staging, retained backups and a fresh original check precede any fixed identity writes', async () => {
  const { state, calls, port } = publicationPort()
  await replacePublication(port, candidate)
  assert.deepEqual(calls, ['observe', 'stage', 'backup', 'observe', 'archive', 'tag', 'image', 'publish', 'verify'])
  assert.deepEqual(state, { tag: 'new', image: 'new', release: 'new', backups: true, staged: true })
})
test('every partial cutover failure restores the old publication and retains backup and staged bytes', async () => {
  for (const failure of ['archive', 'tag', 'image', 'publish', 'verify']) {
    const { state, calls, port } = publicationPort(failure)
    await assert.rejects(replacePublication(port, candidate), /injected failure/)
    assert.equal(calls.at(-1), 'rollback')
    assert.deepEqual(state, { tag: 'old', image: 'old', release: 'old', backups: true, staged: true })
  }
})
test('a publication changed while staging cannot enter cutover', async () => {
  const { state, calls, port } = publicationPort()
  port.observeOriginal = async () => {
    calls.push('observe')
    const observed = structuredClone(original)
    if (state.staged) observed.imageDigest = 'sha256:' + 'f'.repeat(64)
    return observed
  }
  await assert.rejects(replacePublication(port, candidate), /original publication/)
  assert.deepEqual(state, { tag: 'old', image: 'old', release: 'old', backups: true, staged: true })
})

test('replacement authorization is bound to this exact manual source and cannot bypass complete stable CI', () => {
  const env = { GITHUB_REPOSITORY: 'JavdexLabs/Javdex', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: candidate,
    RELEASE_REPLACE_090: 'true', RELEASE_TAG: 'v0.9.0', RELEASE_REPLACEMENT_SOURCE: candidate,
    RELEASE_VERIFY_ONLY: 'false', RELEASE_PRERELEASE: 'false', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1' }
  assert.equal(replacementContext(env).imageTag, 'staged-1234-1')
  for (const change of [{ GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_EVENT_NAME: 'push' }, { RELEASE_REPLACE_090: 'false' },
    { RELEASE_TAG: 'v0.8.0' }, { RELEASE_VERIFY_ONLY: 'true' }, { RELEASE_PRERELEASE: 'true' },
    { RELEASE_REPLACEMENT_SOURCE: 'f'.repeat(40) }, { GITHUB_RUN_ID: '../unbound' }]) {
    assert.throws(() => replacementContext({ ...env, ...change }))
  }
})

test('controlled preflight reads captured metadata and registry HEAD only, and fails closed on unavailable state', async () => {
  const env = { GITHUB_REPOSITORY: 'JavdexLabs/Javdex', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: candidate,
    RELEASE_REPLACE_090: 'true', RELEASE_TAG: 'v0.9.0', RELEASE_REPLACEMENT_SOURCE: candidate,
    GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'fixture-not-a-credential' }
  for (const error of [undefined, 'github', 'registry']) {
    const calls = []
    const api = replacementApi(env, async (input, init = {}) => {
      const url = String(input); calls.push([url, init.method ?? 'GET'])
      if (url.endsWith('/releases/tags/v0.9.0')) return Response.json(original.release, { status: error === 'github' ? 503 : 200 })
      if (url.endsWith('/git/ref/tags/v0.9.0')) return Response.json({ object: original.tag })
      if (url.includes('/releases/tags/staged%2F')) return Response.json({}, { status: 404 })
      if (url.endsWith('/releases?per_page=100')) return Response.json([original.release])
      if (url.startsWith('https://ghcr.io/token?')) return Response.json({ token: 'fixture-read-token' })
      if (url.includes('/manifests/')) {
        assert.equal(init.method, 'HEAD', 'No software or image body may be downloaded by preflight')
        const originalImage = url.endsWith('/manifests/0.9.0')
        return new Response(null, { status: error === 'registry' ? 500 : originalImage ? 200 : 404,
          headers: originalImage ? { 'docker-content-digest': original.imageDigest } : {} })
      }
      throw Error('Unexpected publication request: ' + url)
    })
    if (error) await assert.rejects(api.preflight())
    else assert.equal((await api.preflight()).releaseId, 416016386)
    assert.ok(calls.every(([, method]) => ['GET', 'HEAD'].includes(method)))
  }
})
