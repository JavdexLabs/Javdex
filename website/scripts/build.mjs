#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const websiteDir = path.join(scriptDir, '..')
const rootDir = path.join(websiteDir, '..')
const outputDir = path.join(rootDir, 'dist-pages')
const repository = process.env.GITHUB_REPOSITORY || 'JavdexLabs/Javdex'
const releasePage = `https://github.com/${repository}/releases/latest`
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`

const assetMatchers = {
  windowsX64: /^Javdex-Setup-.+-x64\.exe$/i,
  macArm64: /^Javdex-.+-arm64\.dmg$/i,
  macX64: /^Javdex-.+-x64\.dmg$/i,
  linuxAppImage: /^Javdex-.+-x86_64\.AppImage$/i,
  linuxDeb: /^Javdex-.+-amd64\.deb$/i
}

function fallbackManifest() {
  return {
    schemaVersion: 1,
    version: '最新正式版',
    releaseUrl: releasePage,
    publishedAt: null,
    downloads: {}
  }
}

async function fetchLatestRelease() {
  if (process.argv.includes('--offline')) return fallbackManifest()

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Javdex-Pages-Builder',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const response = await fetch(releaseApi, { headers })
  if (!response.ok) throw new Error(`GitHub Release API returned HTTP ${response.status}`)
  const release = await response.json()
  const downloads = {}

  for (const [key, pattern] of Object.entries(assetMatchers)) {
    const asset = release.assets?.find((candidate) => pattern.test(candidate.name))
    if (!asset) continue
    downloads[key] = {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      contentType: asset.content_type
    }
  }

  const missing = Object.keys(assetMatchers).filter((key) => !downloads[key])
  if (missing.length > 0) {
    throw new Error(`Latest release is missing required downloads: ${missing.join(', ')}`)
  }

  return {
    schemaVersion: 1,
    version: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    downloads
  }
}

async function resolveReleaseManifest() {
  try {
    return await fetchLatestRelease()
  } catch (error) {
    if (process.env.CI === 'true') throw error
    console.warn(`Release manifest fallback: ${error.message}`)
    return fallbackManifest()
  }
}

async function copyWebsite() {
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(path.join(outputDir, 'assets', 'screenshots'), { recursive: true })

  for (const file of ['index.html', 'styles.css', 'app.js', 'robots.txt', 'sitemap.xml']) {
    await cp(path.join(websiteDir, file), path.join(outputDir, file))
  }

  await cp(path.join(rootDir, 'build', 'icon-1024.png'), path.join(outputDir, 'assets', 'icon.png'))
  for (const screenshot of ['library.jpg', 'video-detail.jpg', 'settings.jpg']) {
    await cp(
      path.join(rootDir, 'docs', 'images', screenshot),
      path.join(outputDir, 'assets', 'screenshots', screenshot)
    )
  }

  await writeFile(path.join(outputDir, '.nojekyll'), '', 'utf8')
}

async function validateOutput(manifest) {
  const html = await readFile(path.join(outputDir, 'index.html'), 'utf8')
  const requiredReferences = [
    './styles.css',
    './app.js',
    './assets/icon.png',
    './assets/screenshots/library.jpg'
  ]
  for (const reference of requiredReferences) {
    if (!html.includes(reference)) throw new Error(`index.html is missing ${reference}`)
  }
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported release manifest schema')
}

async function main() {
  const manifest = await resolveReleaseManifest()
  await copyWebsite()
  await writeFile(
    path.join(outputDir, 'release.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  await validateOutput(manifest)

  console.log(`GitHub Pages site built at ${path.relative(rootDir, outputDir)}/`)
  console.log(`Release manifest: ${manifest.version} (${Object.keys(manifest.downloads).length} assets)`)
}

await main()
