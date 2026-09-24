import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export function releaseMetadata(version, requestedTag, prerelease = false) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error(`Unsupported release version: ${version}`)
  }
  const tag = requestedTag || `v${version}`
  if (tag !== `v${version}`) throw new Error('Release tag must match package.json version')
  return { tag, version, prerelease: prerelease || version.includes('-') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const requested = process.env.GITHUB_REF_TYPE === 'tag'
    ? process.env.GITHUB_REF_NAME
    : process.env.RELEASE_TAG
  const result = releaseMetadata(version, requested, process.env.RELEASE_PRERELEASE === 'true')
  if (!fs.existsSync(`.github/release-notes/${result.tag}.md`)) throw new Error('Missing release notes')
  const image = `ghcr.io/${process.env.GITHUB_REPOSITORY_OWNER.toLowerCase()}/javdex-server`
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({ ...result, image })
    .map(([key, value]) => `${key}=${value}\n`).join(''))
}
