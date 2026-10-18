import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { replacementBaseline as baseline, replacePublication, assertOriginalPublication } from './release-replacement.mjs'
import { replacementApi } from './release-replacement-api.mjs'

// Deliberately no generic --force mode. This is the one authorized original 0.9.0 only.
const api = replacementApi(), repository = 'JavdexLabs/Javdex'
const directory = path.resolve('release-artifacts'), receiptFile = path.resolve('replacement-receipt.json')
const receipt = { source: api.source, run: process.env.GITHUB_RUN_ID, original: baseline, steps: [] }
const record = async step => { receipt.steps.push({ step, at: new Date().toISOString() }); await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n') }
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1800000 })
const hashFile = async filename => { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex') }
const copyImage = (tag, digest) => command('docker', ['buildx', 'imagetools', 'create', '-t', `${api.image}:${tag}`, `${api.image}@${digest}`])
const reference = tag => `git/ref/tags/${encodeURIComponent(tag)}`
const patchRelease = (id, body) => api.github(`releases/${id}`, 'PATCH', body)
let staged, stagedAssets, stagedImage
const old = await api.observeOriginal()
assertOriginalPublication(old, api.source)
receipt.originalRelease = old.release
await record('observed-original')

async function assertAssets(id, expected) {
  const assets = await api.github(`releases/${id}/assets?per_page=100`)
  const project = entries => entries.map(({ name, size, digest }) => ({ name, size, digest })).sort((a, b) => a.name.localeCompare(b.name))
  assert.deepEqual(project(assets), project(expected), 'Staged Release bytes differ from completed CI outputs')
}
function moveTag(from, to) {
  // Compare-and-swap at the Git transport; never force a branch or bypass protection.
  command('git', ['push', `--force-with-lease=refs/tags/v0.9.0:${from}`, 'origin', `${to}:refs/tags/v0.9.0`])
}
await replacePublication({
  observeOriginal: api.observeOriginal,
  async stage() {
    const names = baseline.assets.map(asset => asset.name).sort()
    stagedAssets = []
    for (const name of names) {
      const filename = path.join(directory, name), stat = await fs.lstat(filename)
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0)
      stagedAssets.push({ name, size: stat.size, digest: 'sha256:' + await hashFile(filename) })
    }
    const sums = (await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')
    assert.equal(sums.length, 9, 'Expected all six installers, combined source and two signed updates')
    const seen = new Set()
    for (const line of sums) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line)
      assert.ok(match && !seen.has(match[2]), 'Invalid or duplicate release checksum')
      seen.add(match[2])
      assert.equal(stagedAssets.find(asset => asset.name === match[2])?.digest, `sha256:${match[1]}`)
    }
    stagedImage = await api.imageDigest(api.imageTag)
    assert.match(stagedImage || '', /^sha256:[a-f0-9]{64}$/)
    assert.notEqual(stagedImage, baseline.imageDigest, 'Replacement must use the newly built image')
    assert.equal(await api.findRelease(api.stagingTag), null)
    staged = await api.github('releases', 'POST', { tag_name: api.stagingTag, target_commitish: api.source,
      name: `Javdex v0.9.0 replacement staging ${process.env.GITHUB_RUN_ID}`, draft: true, prerelease: false,
      body: await fs.readFile('release-body.md', 'utf8') })
    receipt.stagedReleaseId = staged.id; receipt.stagedImage = stagedImage
    await record('created-staging-draft')
    command('gh', ['release', 'upload', api.stagingTag, '--repo', repository, ...names.map(name => path.join(directory, name))])
    await assertAssets(staged.id, stagedAssets)
    await record('all-ten-new-assets-staged-and-bound')
  },
  async backup() {
    let archive = await api.github(reference(api.archiveTag))
    if (!archive) archive = await api.github('git/refs', 'POST', { ref: `refs/tags/${api.archiveTag}`, sha: baseline.tagObject })
    assert.equal(archive.object?.type, 'commit'); assert.equal(archive.object.sha, baseline.tagObject)
    const digest = await api.imageDigest(api.archiveImageTag)
    if (digest === null) copyImage(api.archiveImageTag, baseline.imageDigest)
    else assert.equal(digest, baseline.imageDigest, 'Archive image was changed; stop')
    assert.equal(await api.imageDigest(api.archiveImageTag), baseline.imageDigest)
    await record('old-tag-and-image-backed-up')
  },
  async archiveOriginal() {
    await patchRelease(baseline.releaseId, { draft: true, tag_name: api.archiveTag,
      target_commitish: baseline.sourceCommit, name: 'Archived original Javdex v0.9.0 (retained assets)' })
    const retained = await api.github(`releases/${baseline.releaseId}`)
    assert.equal(retained.draft, true); assert.equal(retained.tag_name, api.archiveTag)
    // Retain every old asset ID and byte, not just its filename.
    const projection = assets => assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(projection(retained.assets), projection(baseline.assets))
    await record('original-release-retained-as-archive-draft')
  },
  async moveTag() { moveTag(baseline.tagObject, api.source); await record('fixed-tag-switched') },
  async moveImage() {
    assert.equal(await api.imageDigest('0.9.0'), baseline.imageDigest, 'Fixed image changed during cutover')
    copyImage('0.9.0', stagedImage)
    assert.equal(await api.imageDigest('0.9.0'), stagedImage)
    await record('fixed-image-switched')
  },
  async publish() {
    await assertAssets(staged.id, stagedAssets)
    await patchRelease(staged.id, { tag_name: 'v0.9.0', target_commitish: api.source,
      name: 'Javdex v0.9.0', draft: false, prerelease: false, make_latest: 'true' })
    await record('new-release-published')
  },
  async verify() {
    const published = await api.github('releases/tags/v0.9.0')
    assert.equal(published.id, staged.id); assert.equal(published.target_commitish, api.source)
    assert.equal(published.draft, false); assert.equal(published.prerelease, false)
    assert.equal((await api.github(reference('v0.9.0')))?.object?.sha, api.source)
    assert.equal(await api.imageDigest('0.9.0'), stagedImage)
    assert.equal((await api.github('releases/latest'))?.id, staged.id)
    await assertAssets(staged.id, stagedAssets)
    await record('replacement-complete-metadata-only')
  },
  async rollback() {
    await record('rollback-started')
    const published = await api.github('releases/tags/v0.9.0')
    assert.ok(!published || [staged.id, baseline.releaseId].includes(published.id), 'Foreign Release appeared; refusing to overwrite it')
    if (published?.id === staged.id) await patchRelease(staged.id, { draft: true, tag_name: api.stagingTag })
    const tag = (await api.github(reference('v0.9.0')))?.object
    assert.equal(tag?.type, 'commit')
    if (tag.sha === api.source) moveTag(api.source, baseline.tagObject)
    else assert.equal(tag.sha, baseline.tagObject, 'Foreign tag appeared; refusing to overwrite it')
    const digest = await api.imageDigest('0.9.0')
    if (digest === stagedImage) copyImage('0.9.0', baseline.imageDigest)
    else assert.equal(digest, baseline.imageDigest, 'Foreign image appeared; refusing to overwrite it')
    await patchRelease(baseline.releaseId, { draft: false, tag_name: 'v0.9.0', target_commitish: baseline.sourceCommit,
      name: old.release.name, body: old.release.body, prerelease: false, make_latest: 'true' })
    assertOriginalPublication(await api.observeOriginal(), api.source)
    await record('rollback-restored-original-assets-tag-image')
  }
}, api.source)
console.log('Controlled 0.9.0 replacement completed; original assets retained in archival Draft. No independent public artifact acceptance performed.')
