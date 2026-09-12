import { buildSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'out', 'server')
const webSource = path.join(root, 'out', 'web')
const product = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const alias = {
  '@shared': path.join(root, 'packages', 'contracts', 'src'),
  '@library': path.join(root, 'packages', 'library', 'src'),
  '@http': path.join(root, 'packages', 'http', 'src')
}

function forbidDesktopPlugin() {
  return {
    name: 'forbid-desktop',
    setup(build) {
      build.onResolve({ filter: /^(electron|playwright|playwright-core)(\/|$)/ }, (args) => ({
        errors: [{ text: `server bundle must not import ${args.path}` }]
      }))
      build.onResolve({ filter: /apps\/desktop/ }, (args) => ({
        errors: [{ text: `server bundle must not import desktop (${args.path})` }]
      }))
    }
  }
}

function bundle(entry, outfile) {
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    alias,
    plugins: [forbidDesktopPlugin()],
    banner: {
      js: `require = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});`
    }
  })
}

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
bundle(path.join(root, 'apps/server/src/index.ts'), path.join(outDir, 'index.js'))
bundle(path.join(root, 'apps/server/src/webCatalogWorker.ts'), path.join(outDir, 'webCatalogWorker.js'))

if (!fs.existsSync(path.join(webSource, 'index.html'))) {
  throw new Error('server:build requires out/web/index.html; run npm run web:build first')
}
fs.cpSync(webSource, path.join(outDir, 'web'), { recursive: true })

const production = {
  name: 'javdex-server',
  version: product.version,
  private: true,
  license: 'MIT',
  description: 'Production closure for the Javdex Node server. Native modules only; sources are bundled.',
  dependencies: {
    'better-sqlite3': product.dependencies['better-sqlite3'],
    sharp: product.dependencies.sharp
  }
}
fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(production, null, 2)}\n`)
fs.writeFileSync(
  path.join(outDir, 'closure.json'),
  `${JSON.stringify(
    {
      bundled: ['apps/server', 'packages/library', 'packages/http', 'packages/contracts'],
      native: ['better-sqlite3', 'sharp'],
      excluded: ['electron', 'playwright', 'playwright-core', '@earendil-works/pi-coding-agent', 'apps/desktop']
    },
    null,
    2
  )}\n`
)

console.log(`server build written to ${outDir}`)
