import assert from 'node:assert/strict'
import { replacementContext, assertOriginalPublication } from './release-replacement.mjs'

const repository = 'JavdexLabs/Javdex'
const image = 'ghcr.io/javdexlabs/javdex-server'
export function replacementApi(env = process.env, fetcher = fetch) {
  const context = replacementContext(env)
  const headers = { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Javdex-Controlled-090-Replacement', Authorization: `Bearer ${env.GITHUB_TOKEN}` }
  assert.ok(env.GITHUB_TOKEN, 'Missing CI token')
  async function github(suffix, method = 'GET', body) {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${suffix}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000), redirect: 'error'
    })
    if (method === 'GET' && response.status === 404) return null
    assert.ok(response.ok, `Replacement GitHub ${method} HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  // Identity/availability only, never downloads image layers or software assets.
  async function imageDigest(tag) {
    const name = image.slice('ghcr.io/'.length)
    const response = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`, {
      signal: AbortSignal.timeout(15000), redirect: 'error'
    })
    assert.equal(response.status, 200, 'Cannot read registry identity')
    const { token } = await response.json()
    assert.ok(typeof token === 'string' && token.length > 0 && token.length < 16384)
    const head = await fetcher(`https://ghcr.io/v2/${name}/manifests/${tag}`, {
      method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
      signal: AbortSignal.timeout(15000), redirect: 'error'
    })
    if (head.status === 404) return null
    assert.equal(head.status, 200, 'Cannot read image identity')
    const digest = head.headers.get('docker-content-digest')
    assert.match(digest || '', /^sha256:[a-f0-9]{64}$/)
    return digest
  }
  async function observeOriginal() {
    const [release, tag, digest] = await Promise.all([github('releases/tags/v0.9.0'), github('git/ref/tags/v0.9.0'), imageDigest('0.9.0')])
    return { release, tag: tag?.object, imageDigest: digest }
  }
  async function findRelease(tag) {
    const published = await github(`releases/tags/${encodeURIComponent(tag)}`)
    if (published) return published
    // GitHub does not resolve an untagged Draft through the tag endpoint.
    const releases = await github('releases?per_page=100')
    assert.ok(Array.isArray(releases) && releases.length < 100, 'Expected complete bounded Release list')
    const matches = releases.filter(release => release.tag_name === tag)
    assert.ok(matches.length <= 1, 'Duplicate staging Drafts require attention')
    return matches[0] ?? null
  }
  async function preflight() {
    const result = assertOriginalPublication(await observeOriginal(), context.source)
    assert.equal(await findRelease(context.stagingTag), null, 'This run has already staged a Release')
    assert.equal(await imageDigest(context.imageTag), null, 'This run has already staged its image')
    return result
  }
  return { ...context, github, imageDigest, observeOriginal, findRelease, preflight, image }
}
