#!/usr/bin/env node

import { createRequire } from 'node:module'
import path from 'node:path'

const archive = path.resolve(process.argv[2] ?? '')
const requireFromApp = createRequire(path.join(archive, 'package.json'))
const cheerio = requireFromApp('cheerio')
const cheerioSlim = requireFromApp('cheerio/slim')
const undici = requireFromApp('undici')

if (
  typeof cheerio.load !== 'function' ||
  typeof cheerioSlim.load !== 'function' ||
  typeof undici.fetch !== 'function'
) {
  throw new Error('Packaged Cheerio or Undici exports are invalid')
}

console.log('Packaged Node module smoke passed')
