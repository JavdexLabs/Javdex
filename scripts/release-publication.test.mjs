import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const sha = 'a'.repeat(40)
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const tag = `v${version}`
const preload = `
  const fixture = JSON.parse(process.env.PUBLICATION_FIXTURE);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/releases/tags/')) return new Response(JSON.stringify(Object.hasOwn(fixture, 'release') ? fixture.release : {}), { status: fixture.releaseStatus ?? 404 });
    if (url.includes('/git/ref/tags/')) return new Response(JSON.stringify(fixture.ref ?? {}), { status: fixture.refStatus ?? 404 });
    if (url.includes('/git/tags/')) return new Response(JSON.stringify({ object: fixture.annotated }), { status: 200 });
    if (url.startsWith('https://ghcr.io/token?')) return new Response(JSON.stringify({ token: 'public-fixture-token' }));
    if (url.includes('/manifests/')) {
      if (init.method !== 'HEAD') throw new Error('Preflight must not download an image manifest or layers');
      return new Response(null, { status: fixture.imageStatus ?? 404 });
    }
    throw new Error('Unexpected release request: ' + url);
  };
`

function run(fixture = {}, extra = {}, script = 'release-metadata.mjs', args = []) {
  fixture = { refStatus: 200, ref: { object: { type: 'commit', sha } }, ...fixture }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'javdex-publication-check-'))
  try {
    const output = path.join(directory, 'outputs')
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, `scripts/${script}`, ...args], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'JavdexLabs/Javdex', GITHUB_REPOSITORY_OWNER: 'JavdexLabs',
        GITHUB_REF_TYPE: 'branch', GITHUB_SHA: sha, RELEASE_TAG: tag, RELEASE_PRERELEASE: 'false',
        RELEASE_VERIFY_ONLY: 'false', RELEASE_REPLACE_090: 'false', PUBLICATION_FIXTURE: JSON.stringify(fixture), ...extra }
    })
    return { ...result, output: result.status === 0 && script === 'release-metadata.mjs' ? readFileSync(output, 'utf8') : '' }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('metadata rejects an already published Release before any build or publication', () => {
  const result = run({ releaseStatus: 200, release: { tag_name: 'v0.9.0' } })
  assert.notEqual(result.status, 0, 'published versions cannot be reused, even at the same source')
  assert.match(result.stderr, /already exists/)
})
test('a malformed successful GitHub response cannot masquerade as a missing Release', () => {
  // The preload preserves an explicit null rather than treating it as a 404.
  const result = run({ releaseStatus: 200, release: null })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Invalid release preflight GitHub response/)
})
test('metadata rejects an existing tag from a different source', () => {
  const result = run({ refStatus: 200, ref: { object: { type: 'commit', sha: 'b'.repeat(40) } } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /different source/)
})
test('metadata rejects an already public fixed image without downloading it', () => {
  const result = run({ imageStatus: 200 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /image.*already exists/i)
})
test('unknown API and registry failures cannot be interpreted as absence', () => {
  for (const fixture of [{ releaseStatus: 503 }, { refStatus: 403 }, { imageStatus: 401 }, { imageStatus: 500 }]) {
    const result = run(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /HTTP/)
  }
})
test('fresh metadata with an existing matching lightweight or annotated tag may proceed', () => {
  for (const fixture of [{ refStatus: 200, ref: { object: { type: 'commit', sha } } },
    { refStatus: 200, ref: { object: { type: 'tag', sha: 'c'.repeat(40) } }, annotated: { type: 'commit', sha } }]) {
    const result = run(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.output.includes(`tag=${tag}\n`))
  }
})
test('verify-only metadata never requires publication APIs', () => {
  const result = run({ releaseStatus: 500 }, { RELEASE_VERIFY_ONLY: 'true' })
  assert.equal(result.status, 0, result.stderr)
})

test('replayed publication jobs recheck the immutable boundary immediately before writing', () => {
  for (const phase of ['manifest', 'release']) {
    const result = run({ releaseStatus: 200 }, {}, 'release-publication.mjs', [phase])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /already exists/)
    const changedTag = run({ refStatus: 200, ref: { object: { type: 'commit', sha: 'b'.repeat(40) } } }, {}, 'release-publication.mjs', [phase])
    assert.notEqual(changedTag.status, 0)
    assert.match(changedTag.stderr, /different source/)
  }
  const existingImage = run({ imageStatus: 200 }, {}, 'release-publication.mjs', ['manifest'])
  assert.notEqual(existingImage.status, 0)
  assert.match(existingImage.stderr, /already exists/)
  const ownImage = run({ imageStatus: 200, refStatus: 200, ref: { object: { type: 'commit', sha } } }, {}, 'release-publication.mjs', ['release'])
  assert.equal(ownImage.status, 0, ownImage.stderr)
})

test('release upload requires a pre-existing source-bound tag instead of implicit tag creation', () => {
  for (const [script, args] of [['release-metadata.mjs', []], ['release-publication.mjs', ['manifest']], ['release-publication.mjs', ['release']]]) {
    const missingTag = run({ refStatus: 404 }, {}, script, args)
    assert.notEqual(missingTag.status, 0)
    assert.match(missingTag.stderr, /must exist before publication/)
  }
  for (const fixture of [
    { refStatus: 200, ref: { object: { type: 'commit', sha } } },
    { refStatus: 200, ref: { object: { type: 'tag', sha: 'c'.repeat(40) } }, annotated: { type: 'commit', sha } }
  ]) {
    const result = run(fixture, {}, 'release-publication.mjs', ['release'])
    assert.equal(result.status, 0, result.stderr)
  }
})

test('workflow serializes refs and wires fresh guards ahead of both fixed publications', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  assert.match(workflow, /group: release-publication\n/)
  assert.match(workflow, /RELEASE_VERIFY_ONLY: \$\{\{ inputs.verify_only \}\}/)
  const manifest = workflow.split('\n  server-manifest:\n')[1].split('\n  release:\n')[0]
  assert.ok(manifest.indexOf('node scripts/release-publication.mjs manifest') < manifest.indexOf('docker buildx imagetools create'))
  assert.ok(manifest.includes('node scripts/release-publication.mjs manifest'))
  const release = workflow.split('\n  release:\n')[1]
  assert.ok(release.indexOf('node scripts/release-publication.mjs release') < release.indexOf('uses: softprops/action-gh-release@'))
  assert.ok(release.includes('node scripts/release-publication.mjs release'))
  assert.ok(!release.includes('target_commitish:'), 'an existing source-checked tag does not need workflow-edit permission')
})
