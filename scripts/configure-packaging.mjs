#!/usr/bin/env node
/**
 * Enable/disable packaging targets in build/packaging.targets.json
 *
 * Usage:
 *   node scripts/configure-packaging.mjs --enable win-nsis,win-portable
 *   node scripts/configure-packaging.mjs --disable mac-dmg
 *   node scripts/configure-packaging.mjs --only win-nsis
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'build', 'packaging.targets.json')

function parseArgs(argv) {
  const args = { enable: null, disable: null, only: null, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--list') args.list = true
    else if (arg === '--enable') args.enable = new Set(String(argv[++i] ?? '').split(',').filter(Boolean))
    else if (arg === '--disable') args.disable = new Set(String(argv[++i] ?? '').split(',').filter(Boolean))
    else if (arg === '--only') args.only = new Set(String(argv[++i] ?? '').split(',').filter(Boolean))
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const platforms = manifest.platforms ?? []
  const ids = new Set(platforms.map((item) => item.id))

  if (args.list) {
    for (const item of platforms) {
      console.log(`${item.enabled ? 'x' : ' '} ${item.id} — ${item.label}`)
    }
    return
  }

  if (args.only) {
    for (const id of args.only) {
      if (!ids.has(id)) {
        console.error(`Unknown target: ${id}`)
        process.exit(1)
      }
    }
    for (const item of platforms) {
      item.enabled = args.only.has(item.id)
    }
  } else {
    if (args.enable) {
      for (const id of args.enable) {
        if (!ids.has(id)) {
          console.error(`Unknown target: ${id}`)
          process.exit(1)
        }
      }
      for (const item of platforms) {
        if (args.enable.has(item.id)) item.enabled = true
      }
    }
    if (args.disable) {
      for (const id of args.disable) {
        if (!ids.has(id)) {
          console.error(`Unknown target: ${id}`)
          process.exit(1)
        }
      }
      for (const item of platforms) {
        if (args.disable.has(item.id)) item.enabled = false
      }
    }
  }

  if (!args.only && !args.enable && !args.disable) {
    console.error('Usage: --enable <ids> | --disable <ids> | --only <ids> | --list')
    process.exit(1)
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log('Updated build/packaging.targets.json:')
  for (const item of platforms) {
    if (item.enabled) console.log(`  [enabled] ${item.id} — ${item.label}`)
  }
}

main()
