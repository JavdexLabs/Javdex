import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Read-only, fail-closed checks. A published version always needs a new number. */
export async function assertReleaseAvailable({ tag, version, image, phase = 'prepare', env = process.env, fetcher = fetch }) {
  const repository = env.GITHUB_REPOSITORY
  const source = env.GITHUB_SHA
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('Missing release repository or source SHA')
  if (!['prepare', 'manifest', 'release'].includes(phase)) throw new Error('Unknown publication phase')
  if (tag !== `v${version}` || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)
    || image !== `ghcr.io/${repository.split('/')[0].toLowerCase()}/javdex-server`) throw new Error('Invalid publication target')
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Javdex-Release-Preflight' }
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  async function github(suffix) {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${suffix}`, { headers, signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (response.status === 404) return null
    if (response.status !== 200) throw new Error(`Release preflight GitHub HTTP ${response.status}`)
    const value = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release preflight GitHub response')
    return value
  }
  if (await github(`releases/tags/${encodeURIComponent(tag)}`)) throw new Error(`Release ${tag} already exists; choose a new version`)
  const reference = await github(`git/ref/tags/${encodeURIComponent(tag)}`)
  if (reference) {
    let object = reference.object
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha ?? '')) throw new Error('Invalid annotated release tag')
      object = (await github(`git/tags/${object.sha}`))?.object
    }
    if (object?.type !== 'commit' || object.sha !== source) throw new Error(`Tag ${tag} points to a different source; tags cannot be moved`)
  }
  // The release job follows this run's manifest publication. It must still reject
  // an existing GitHub Release, but the now-existing image is expected there.
  if (phase === 'release') return
  const name = image.slice('ghcr.io/'.length)
  const tokenResponse = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`, {
    signal: AbortSignal.timeout(15_000), redirect: 'error'
  })
  if (tokenResponse.status !== 200) throw new Error(`Release preflight registry token HTTP ${tokenResponse.status}`)
  const { token } = await tokenResponse.json()
  if (typeof token !== 'string' || !token || token.length > 16_384) throw new Error('Invalid registry read token')
  // HEAD is sufficient: never fetch image manifests, configurations or layers.
  const response = await fetcher(`https://ghcr.io/v2/${name}/manifests/${version}`, {
    method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error'
  })
  if (response.status === 200) throw new Error(`Image ${image}:${version} already exists; choose a new version`)
  if (response.status !== 404) throw new Error(`Release preflight registry HTTP ${response.status}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const metadata = { version, tag: process.env.RELEASE_TAG || `v${version}` }
  await assertReleaseAvailable({ ...metadata, image: `ghcr.io/${process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase()}/javdex-server`, phase: process.argv[2] })
  console.log(`Publication checks passed for ${metadata.tag} (${process.argv[2]}).`)
}
