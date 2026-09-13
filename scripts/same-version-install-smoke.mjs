#!/usr/bin/env node
/**
 * Same-source-version desktop package + server image install smoke.
 *
 * Requires already-built artifacts:
 *   - out/server from `npm run server:build`
 *   - Linux desktop package(s) from `npm run dist:linux` (deb and/or AppImage
 *     plus electron-builder linux-unpacked)
 *
 * Honest Linux Cloud VM scope:
 *   - Unpacks the .deb (install-like) and verifies app.asar + Agent runtime
 *   - Builds/runs the production Dockerfile image and asserts its version
 *   - Optionally starts the unpacked desktop binary under Xvfb
 *   - Does not produce or claim Windows NSIS/ZIP or macOS DMG/signing
 *
 * Missing Docker or missing Linux artifacts exit non-zero. Do not skip silently.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaces = [
  'apps/desktop',
  'apps/web',
  'apps/server',
  'packages/contracts',
  'packages/ui',
  'packages/library',
  'packages/http'
]

function parseArgs(argv) {
  const args = {
    dist: path.join(root, 'dist'),
    serverOut: path.join(root, 'out', 'server'),
    skipServerSmoke: false,
    skipGui: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dist') args.dist = path.resolve(String(argv[++i] ?? ''))
    else if (arg === '--server-out') args.serverOut = path.resolve(String(argv[++i] ?? ''))
    else if (arg === '--skip-server-smoke') args.skipServerSmoke = true
    else if (arg === '--skip-gui') args.skipGui = true
  }
  return args
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? 'pipe'
  })
}

function requireStatus(result, label) {
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn'}):\n${detail}`)
  }
  return result
}

function findFiles(directory, predicate, depth = 0) {
  if (depth > 6 || !fs.existsSync(directory)) return []
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isFile() && predicate(entry.name, target)) found.push(target)
    else if (entry.isDirectory()) found.push(...findFiles(target, predicate, depth + 1))
  }
  return found
}

function assertWorkspaceVersions(version) {
  for (const directory of workspaces) {
    const manifest = readJson(path.join(root, directory, 'package.json'))
    assert.equal(manifest.version, version, `${directory} version must match ${version}`)
  }
}

function assertServerClosure(serverOut, version, product) {
  const productionPath = path.join(serverOut, 'package.json')
  assert.ok(fs.existsSync(productionPath), `missing ${productionPath}; run npm run server:build`)
  const production = readJson(productionPath)
  assert.equal(production.version, version, `out/server version must be ${version}`)
  assert.deepEqual(Object.keys(production.dependencies).sort(), ['better-sqlite3', 'sharp'])
  assert.equal(production.dependencies['better-sqlite3'], product.dependencies['better-sqlite3'])
  assert.equal(production.dependencies.sharp, product.dependencies.sharp)
  for (const file of ['index.js', 'webCatalogWorker.js']) {
    assert.ok(fs.existsSync(path.join(serverOut, file)), `missing ${file} in out/server`)
  }
  assert.ok(fs.existsSync(path.join(serverOut, 'web', 'index.html')), 'missing out/server/web/index.html')
  const indexSource = fs.readFileSync(path.join(serverOut, 'index.js'), 'utf8')
  assert.equal(/\bfrom ["']electron["']|\brequire\(["']electron["']\)/.test(indexSource), false)
  console.log(`PASS: out/server ${production.version} (better-sqlite3 + sharp only)`)
  return production
}

function listLinuxArtifacts(distDir, version) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`missing ${distDir}; run npm run dist:linux on Linux`)
  }
  const names = fs.readdirSync(distDir)
  const deb = names
    .filter((name) => name.endsWith('.deb') && name.includes(version))
    .map((name) => path.join(distDir, name))
  const appImage = names
    .filter((name) => name.toLowerCase().endsWith('.appimage') && name.includes(version))
    .map((name) => path.join(distDir, name))
  const unpacked = path.join(distDir, 'linux-unpacked')
  return {
    deb,
    appImage,
    unpacked: fs.existsSync(unpacked) ? unpacked : null,
    names
  }
}

function unpackDeb(debPath) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-deb-unpack-'))
  requireStatus(run('dpkg-deb', ['-x', debPath, dest]), `dpkg-deb -x ${debPath}`)
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-deb-control-'))
  requireStatus(run('dpkg-deb', ['-e', debPath, control]), `dpkg-deb -e ${debPath}`)
  return { dest, control }
}

function readDebControl(controlDir) {
  const controlFile = path.join(controlDir, 'control')
  const text = fs.readFileSync(controlFile, 'utf8')
  const version = text.match(/^Version:\s*(.+)$/m)?.[1]?.trim()
  const packageName = text.match(/^Package:\s*(.+)$/m)?.[1]?.trim()
  return { version, packageName, text }
}

function asarPackageJson(archive) {
  return JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
}

function requireDocker() {
  const version = run('docker', ['version'])
  if (version.status !== 0) {
    process.stderr.write(
      'smoke:same-version-install requires Docker to build the Linux server image from this commit.\n'
    )
    process.stderr.write(version.stderr || version.stdout || 'docker is not available\n')
    process.exit(1)
  }
}

function dockerImageVersion(image) {
  const script =
    "import fs from 'node:fs'; const p = JSON.parse(fs.readFileSync('/app/package.json','utf8')); process.stdout.write(JSON.stringify({ version: p.version, dependencies: p.dependencies }));"
  const result = requireStatus(
    run('docker', ['run', '--rm', '--entrypoint', 'node', image, '--input-type=module', '-e', script]),
    `docker run ${image} package.json`
  )
  return JSON.parse(result.stdout)
}

function verifyPackagedRuntime(targetDir) {
  const verify = path.join(root, 'scripts', 'check-packaged-agent-runtime.mjs')
  requireStatus(run(process.execPath, [verify, targetDir], { stdio: 'inherit' }), 'packaging:verify-agent-runtime')
}

function tryGuiStart(executable, skipGui) {
  if (skipGui) {
    console.log('SKIP: desktop GUI start (--skip-gui)')
    return { attempted: false, started: false, reason: 'skip-gui' }
  }
  if (process.platform !== 'linux') {
    return { attempted: false, started: false, reason: `host is ${process.platform}` }
  }
  const xvfb = run('sh', ['-c', 'command -v xvfb-run'])
  if (xvfb.status !== 0) {
    console.log('SKIP: desktop GUI start (xvfb-run not installed)')
    return { attempted: false, started: false, reason: 'no-xvfb' }
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-packaged-userdata-'))
  const result = run(
    'xvfb-run',
    [
      '-a',
      'timeout',
      '--signal=TERM',
      '--kill-after=5s',
      '12s',
      executable,
      '--no-sandbox',
      `--user-data-dir=${userData}`
    ],
    { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } }
  )
  const output = `${result.stdout}\n${result.stderr}`
  const started =
    result.status === 124 ||
    /Electron|Javdex|ready-to-show|BrowserWindow|Gpu/i.test(output)
  console.log(
    started
      ? `PASS: unpacked desktop binary stayed up under Xvfb long enough to be killed (exit ${result.status})`
      : `NOTE: unpacked desktop binary did not stay up under Xvfb (exit ${result.status}); packaging verify remains the desktop proof`
  )
  if (!started && output.trim()) {
    console.log(output.trim().slice(0, 4000))
  }
  return { attempted: true, started, exit: result.status, output: output.slice(0, 4000) }
}

function nodeVersionFromPackaged(executable) {
  const result = run(executable, ['-e', 'process.stdout.write(JSON.stringify(process.versions))'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  requireStatus(result, `${executable} ELECTRON_RUN_AS_NODE versions`)
  return JSON.parse(result.stdout)
}

function findPackagedExecutable(appRoot) {
  const names = ['Javdex', 'javdex']
  for (const name of names) {
    const candidate = path.join(appRoot, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function findAppRootFromUnpack(dest) {
  const asars = findFiles(dest, (name) => name === 'app.asar')
  if (asars.length === 0) {
    throw new Error(`unpacked tree ${dest} has no app.asar`)
  }
  return path.dirname(path.dirname(asars[0]))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const product = readJson(path.join(root, 'package.json'))
  const version = product.version
  assert.match(version, /^\d+\.\d+\.\d+$/, 'product version must be MAJOR.MINOR.PATCH')
  assertWorkspaceVersions(version)
  console.log(`PASS: workspace versions ${version}`)

  assertServerClosure(args.serverOut, version, product)

  const artifacts = listLinuxArtifacts(args.dist, version)
  if (artifacts.deb.length === 0 && !artifacts.unpacked) {
    throw new Error(
      `No Linux .deb or linux-unpacked for ${version} under ${args.dist}. ` +
        `This host can only produce Linux packages (see packaging.targets.json). ` +
        `Found: ${artifacts.names.join(', ') || '(empty)'}`
    )
  }
  console.log(
    `Linux artifacts: deb=${artifacts.deb.map((item) => path.basename(item)).join(',') || 'none'} ` +
      `appimage=${artifacts.appImage.map((item) => path.basename(item)).join(',') || 'none'} ` +
      `linux-unpacked=${artifacts.unpacked ? 'yes' : 'no'}`
  )

  const cleanup = []
  try {
    let appRoot = artifacts.unpacked
    let packaged = null
    if (artifacts.deb.length > 0) {
      const debPath = artifacts.deb[0]
      const unpacked = unpackDeb(debPath)
      cleanup.push(unpacked.dest, unpacked.control)
      const control = readDebControl(unpacked.control)
      assert.equal(control.version, version, `deb control Version must be ${version}`)
      console.log(`PASS: dpkg-deb unpacked ${path.basename(debPath)} (Package=${control.packageName} Version=${control.version})`)
      appRoot = findAppRootFromUnpack(unpacked.dest)
      const asars = findFiles(unpacked.dest, (name) => name === 'app.asar')
      packaged = asarPackageJson(asars[0])
    } else if (artifacts.unpacked) {
      const asars = findFiles(artifacts.unpacked, (name) => name === 'app.asar')
      if (asars.length === 0) throw new Error('linux-unpacked has no app.asar')
      packaged = asarPackageJson(asars[0])
    }

    assert.equal(packaged?.version, version, `packaged app version must be ${version}`)
    console.log(`PASS: packaged app.asar version ${packaged.version}`)

    if (appRoot) {
      verifyPackagedRuntime(appRoot)
      const executable = findPackagedExecutable(appRoot)
      if (!executable) {
        throw new Error(`no Javdex/javdex executable under ${appRoot}`)
      }
      const versions = nodeVersionFromPackaged(executable)
      assert.ok(versions.electron, 'packaged binary did not report process.versions.electron')
      console.log(`PASS: packaged Electron ${versions.electron} chrome ${versions.chrome} (ELECTRON_RUN_AS_NODE)`)
      tryGuiStart(executable, args.skipGui)
    }

    if (artifacts.appImage.length > 0) {
      const appImage = artifacts.appImage[0]
      const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-appimage-'))
      cleanup.push(extractRoot)
      const extract = run(appImage, ['--appimage-extract'], { cwd: extractRoot })
      if (extract.status === 0) {
        const asars = findFiles(extractRoot, (name) => name === 'app.asar')
        if (asars.length > 0) {
          const extracted = asarPackageJson(asars[0])
          assert.equal(extracted.version, version, `AppImage app.asar version must be ${version}`)
          console.log(`PASS: AppImage extracted version ${extracted.version}`)
        } else {
          console.log(`NOTE: AppImage extracted but no app.asar under ${extractRoot}`)
        }
      } else {
        console.log(
          `NOTE: AppImage --appimage-extract failed (exit ${extract.status}); deb unpack remains the Linux install proof\n${extract.stderr || extract.stdout}`
        )
      }
    }

    requireDocker()
    const image = 'javdex-server:smoke'
    requireStatus(run('docker', ['build', '-t', image, '.'], { stdio: 'inherit' }), 'docker build javdex-server:smoke')
    const imagePackage = dockerImageVersion(image)
    assert.equal(imagePackage.version, version, `server image version must be ${version}`)
    assert.deepEqual(Object.keys(imagePackage.dependencies).sort(), ['better-sqlite3', 'sharp'])
    console.log(`PASS: docker image ${image} version ${imagePackage.version}`)

    if (args.skipServerSmoke) {
      console.log('SKIP: server:smoke (--skip-server-smoke)')
    } else {
      requireStatus(run('npm', ['run', 'server:smoke'], { stdio: 'inherit' }), 'server:smoke')
    }

    console.log(
      `PASS: same-version install smoke ${version} (Linux desktop package + server image). ` +
        'Windows/macOS installers were not built on this host. Not S13/S14 complete.'
    )
  } finally {
    for (const directory of cleanup) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

await main()
