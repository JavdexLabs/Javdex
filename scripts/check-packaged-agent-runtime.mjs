#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { listPackage } from '@electron/asar'

const root = path.resolve(process.argv[2] ?? 'dist')

function findAsars(directory, depth = 0) {
  if (depth > 5 || !existsSync(directory)) return []
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === 'app.asar') found.push(target)
    else if (entry.isDirectory()) found.push(...findAsars(target, depth + 1))
  }
  return found
}

const archives = findAsars(root)
if (archives.length === 0) {
  throw new Error(`No packaged app.asar found under ${root}`)
}

for (const archive of archives) {
  const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'))
  const required = [
    /^\/out\/main\/chunks\/piRuntime-.*\.js$/,
    /^\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/index\.js$/,
    /^\/node_modules\/@earendil-works\/pi-coding-agent\/node_modules\/@earendil-works\/pi-ai\/dist\/index\.js$/
  ]
  for (const pattern of required) {
    if (!entries.some((entry) => pattern.test(entry))) {
      throw new Error(`${archive} is missing required Agent runtime entry ${pattern}`)
    }
  }
  const nonRuntime = entries.filter((entry) => /\.(?:d\.ts|[jd]s\.map)$/.test(entry))
  if (nonRuntime.length > 0) {
    throw new Error(`${archive} contains ${nonRuntime.length} type/source-map files`)
  }
  const sizeMiB = (statSync(archive).size / 1024 / 1024).toFixed(1)
  console.log(`Packaged Agent runtime verified: ${archive} (${sizeMiB} MiB)`)
}
