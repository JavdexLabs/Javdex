#!/usr/bin/env node
/**
 * Build production bundles and package enabled targets from build/packaging.targets.json.
 *
 * Usage:
 *   node scripts/dist.mjs              # all enabled targets
 *   node scripts/dist.mjs --list       # show manifest
 *   node scripts/dist.mjs --only win-nsis,win-portable
 *   node scripts/dist.mjs --platform win
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'build', 'packaging.targets.json')

function readManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing packaging manifest: ${manifestPath}`)
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function parseArgs(argv) {
  const args = { list: false, only: null, platform: null, skipBuild: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--list') args.list = true
    else if (arg === '--skip-build') args.skipBuild = true
    else if (arg === '--only') args.only = new Set(String(argv[++i] ?? '').split(',').filter(Boolean))
    else if (arg === '--platform') args.platform = String(argv[++i] ?? '')
  }
  return args
}

function printManifest(platforms) {
  console.log('\nJavdex 打包目标清单\n')
  for (const item of platforms) {
    const flag = item.enabled ? '[x]' : '[ ]'
    console.log(`${flag} ${item.id}`)
    console.log(`    ${item.label} — ${item.description}`)
    console.log(`    产物: ${item.artifact}`)
    console.log(`    构建环境: ${item.buildOn}`)
    console.log('')
  }
  console.log('启用方式: 编辑 build/packaging.targets.json 将 enabled 设为 true')
  console.log('或执行: npm run packaging:configure -- --enable <id>[,<id>...]\n')
}

function selectPlatforms(platforms, args) {
  let selected = platforms
  if (args.only) {
    selected = platforms.filter((item) => args.only.has(item.id))
  } else {
    selected = platforms.filter((item) => item.enabled)
  }
  if (args.platform) {
    selected = selected.filter((item) => item.electronBuilder.platform === args.platform)
  }
  return selected
}

function mergeTargets(selected) {
  /** @type {Record<string, { target: string, arch: string[] }[]>} */
  const byPlatform = {}
  for (const item of selected) {
    const { platform, targets } = item.electronBuilder
    if (!byPlatform[platform]) byPlatform[platform] = []
    for (const entry of targets) {
      const existing = byPlatform[platform].find(
        (row) => row.target === entry.target && row.arch.join(',') === entry.arch.join(',')
      )
      if (!existing) byPlatform[platform].push(entry)
    }
  }
  return byPlatform
}

function run(command, commandArgs, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = readManifest()
  const platforms = manifest.platforms ?? []

  if (args.list) {
    printManifest(platforms)
    return
  }

  const selected = selectPlatforms(platforms, args)
  if (selected.length === 0) {
    console.error('没有启用的打包目标。')
    printManifest(platforms)
    process.exit(1)
  }

  const merged = mergeTargets(selected)
  const platformFlags = Object.keys(merged)
  const targetConfig = JSON.stringify(merged)

  console.log('将打包以下目标:')
  for (const item of selected) {
    console.log(`  - ${item.id}: ${item.label}`)
  }
  console.log('')

  if (!args.skipBuild) {
    console.log('> npm run build')
    run('npm', ['run', 'build'])
  }

  const builderArgs = ['electron-builder', '--config', 'electron-builder.config.mjs']
  for (const platform of platformFlags) {
    builderArgs.push(`--${platform}`)
  }
  builderArgs.push('--config.extraMetadata.main=./out/main/index.js')
  builderArgs.push(`-c.extraMetadata.version=${readPackageVersion()}`)

  console.log(`> npx ${builderArgs.join(' ')}`)
  console.log(`> ELECTRON_BUILDER_TARGETS=${targetConfig}`)
  run('npx', builderArgs, { ELECTRON_BUILDER_TARGETS: targetConfig })
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return pkg.version ?? '0.0.0'
}

main()
