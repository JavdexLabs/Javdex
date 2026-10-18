import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
export const replacementBaseline = JSON.parse(fs.readFileSync(new URL('../build/replacement-0.9.0.json', import.meta.url), 'utf8'))
export function assertOriginalPublication(observed, source) {
  const expected = replacementBaseline
  assert.match(source || '', /^[a-f0-9]{40}$/, 'Expected full replacement source SHA')
  assert.notEqual(source, expected.sourceCommit, 'Replacement must use a different source')
  const changed = 'The original publication has changed; stop before any replacement write'
  assert.equal(expected.formatVersion, 1)
  assert.equal(expected.releaseId, 416016386, 'This authorization covers only the original 0.9.0 Release')
  assert.equal(expected.version, '0.9.0'); assert.equal(expected.tag, 'v0.9.0')
  const release = observed?.release
  assert.ok(release && typeof release === 'object', changed)
  for (const [key, value] of Object.entries({ id: expected.releaseId, tag_name: expected.tag,
    target_commitish: expected.sourceCommit, draft: false, prerelease: false, immutable: false })) assert.equal(release[key], value, changed)
  assert.equal(typeof release.body, 'string', changed)
  assert.equal(createHash('sha256').update(release.body).digest('hex'), expected.bodySha256, changed)
  assert.ok(Array.isArray(release.assets), changed)
  const projection = assets => assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((a, b) => a.name.localeCompare(b.name))
  assert.deepEqual(projection(release.assets), projection(expected.assets), changed)
  assert.equal(observed.tag?.type, 'commit', changed)
  assert.equal(observed.tag.sha, expected.tagObject, changed)
  assert.equal(observed.imageDigest, expected.imageDigest, changed)
  return { releaseId: expected.releaseId, oldSource: expected.sourceCommit, source, oldImage: expected.imageDigest }
}

/** All slow builds and uploads precede this short, recoverable cutover. */
export async function replacePublication(port, source) {
  assertOriginalPublication(await port.observeOriginal(), source)
  await port.stage()
  await port.backup()
  assertOriginalPublication(await port.observeOriginal(), source)
  try {
    await port.archiveOriginal()
    await port.moveTag()
    await port.moveImage()
    await port.publish()
    await port.verify()
  } catch (cause) {
    try { await port.rollback() }
    catch (rollback) { throw new AggregateError([cause, rollback], 'Replacement failed and recovery requires attention; retained backups must not be deleted') }
    throw cause
  }
}

export function replacementContext(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, 'JavdexLabs/Javdex', 'Replacement repository mismatch')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Replacement requires manual dispatch')
  assert.equal(env.RELEASE_REPLACE_090, 'true', 'Replacement is not enabled')
  assert.equal(env.RELEASE_TAG, 'v0.9.0', 'Replacement tag mismatch')
  assert.notEqual(env.RELEASE_VERIFY_ONLY, 'true', 'Replacement requires complete Release CI')
  assert.notEqual(env.RELEASE_PRERELEASE, 'true', 'Replacement must remain stable')
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/)
  assert.equal(env.RELEASE_REPLACEMENT_SOURCE, env.GITHUB_SHA, 'Explicit replacement source must match this checkout')
  assert.notEqual(env.GITHUB_SHA, replacementBaseline.sourceCommit)
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] || '', /^[1-9]\d*$/)
  return { source: env.GITHUB_SHA, imageTag: `staged-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    stagingTag: `staged/0.9.0/${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    archiveTag: `archive/0.9.0/original-${replacementBaseline.sourceCommit}`,
    archiveImageTag: `archive-0.9.0-${replacementBaseline.sourceCommit}` }
}
