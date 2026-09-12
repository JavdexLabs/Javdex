import { build } from 'esbuild'
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
    setup(buildApi) {
      buildApi.onResolve({ filter: /^(electron|playwright|playwright-core)(\/|$)/ }, (args) => ({
        errors: [{ text: `server bundle must not import ${args.path}` }]
      }))
      buildApi.onResolve({ filter: /apps\/desktop/ }, (args) => ({
        errors: [{ text: `server bundle must not import desktop (${args.path})` }]
      }))
    }
  }
}

async function bundle(entry, outfile) {
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['better-sqlite3', 'sharp'],
    alias,
    plugins: [forbidDesktopPlugin()]
  })
}

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  await bundle(path.join(root, 'apps/server/src/index.ts'), path.join(outDir, 'index.js'))
  await bundle(path.join(root, 'apps/server/src/webCatalogWorker.ts'), path.join(outDir, 'webCatalogWorker.js'))

  if (!fs.existsSync(path.join(webSource, 'index.html'))) {
    throw new Error('server:build requires out/web/index.html; run npm run web:build first')
  }
  fs.cpSync(webSource, path.join(outDir, 'web'), { recursive: true })

  for (const file of ['index.js', 'webCatalogWorker.js']) {
    const source = fs.readFileSync(path.join(outDir, file), 'utf8')
    if (/\brequire\(["']electron["']\)|\bfrom ["']electron["']/.test(source)) {
      throw new Error(`${file} unexpectedly references electron`)
    }
  }

  const production = {
    name: 'javdex-server',
    version: product.version,
    private: true,
    license: 'MIT',
    type: 'module',
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
}

await main()
