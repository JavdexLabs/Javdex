import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resumePlan, verifiedAmd64Run, verifiedPublicationRun } from './release-resume.mjs'
import { playbackInstallers } from './playback-source-materials.mjs'

function fixture() {
  const source = 'a'.repeat(40)
  const names = ['metadata', 'Typecheck and test', 'Package win-x64', 'Package mac-x64', 'Package mac-arm64',
    'Package linux-x64', 'Aggregate corresponding playback sources', 'Server image (arm64)']
  return { repository: 'JavdexLabs/Javdex', run: { id: 123, run_attempt: 1, head_sha: source, status: 'completed', conclusion: 'failure',
    path: '.github/workflows/release.yml', repository: { full_name: 'JavdexLabs/Javdex' }, head_repository: { full_name: 'JavdexLabs/Javdex' } },
  jobs: [...names.map(name => ({ name, conclusion: 'success' })),
    { name: 'Server image (amd64)', conclusion: 'failure', steps: [{ name: 'Run npm run server:test', conclusion: 'failure' }] },
    { name: 'Publish GitHub release', conclusion: 'skipped' }],
  artifacts: ['Javdex-win-x64', 'Javdex-mac-x64', 'Javdex-mac-arm64', 'Javdex-linux-x64', 'Playback-Sources-Combined'].map((name, i) => ({
    name, id: i + 1, expired: false, size_in_bytes: 12, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 123, head_sha: source }
  })), changedPaths: ['apps/server/src/dualBackendScan.e2e.test.ts', '.github/workflows/release-resume-server.yml'] }
}

test('resume retains the original candidate and exact immutable artifact IDs', () => {
  const plan = resumePlan(fixture())
  assert.equal(plan.source, 'a'.repeat(40))
  assert.equal(plan.baseRun, 123)
  assert.deepEqual(plan.artifacts.map(a => a.id), [1, 2, 3, 4, 5])
})

function amdFixture() {
  const f = fixture()
  f.run.id = 456
  const names = ['Inspect original run and immutable artifacts', 'Validate signing before publishing images',
    'Build only the missing amd64 product from original source', 'Verify server with the repaired namespace test harness',
    'Run npm run server:updater:test', 'Verify supplementary business groups under Linux root',
    'Run npm run server:updater:smoke', 'Run npm run server:smoke']
  f.jobs = [{ name: 'resume-server / resume', conclusion: 'failure', steps: [
    ...names.map(name => ({ name, conclusion: 'success' })),
    { name: 'Verify reused arm64 identity and pin both architecture digests', conclusion: 'failure' }
  ] }]
  return f
}

test('an uploaded amd64 image may be reused only after all real gates passed', () => {
  const f = amdFixture()
  assert.deepEqual(verifiedAmd64Run(f.repository, f.run, f.jobs, f.changedPaths), { run: 456, attempt: 1, repairSource: f.run.head_sha })
  for (let i = 0; i < 8; i++) {
    const incomplete = amdFixture()
    incomplete.jobs[0].steps[i].conclusion = 'skipped'
    assert.throws(() => verifiedAmd64Run(incomplete.repository, incomplete.run, incomplete.jobs, incomplete.changedPaths))
  }
  assert.throws(() => verifiedAmd64Run(f.repository, f.run, f.jobs, ['apps/server/src/index.ts']))
  f.jobs.push({ name: 'resume-server / manifest', conclusion: 'success' })
  assert.throws(() => verifiedAmd64Run(f.repository, f.run, f.jobs, f.changedPaths))
})

test('publication-only recovery requires a successful fixed image and signed closure checks', () => {
  const f = fixture()
  f.jobs = [{ name: 'resume-server / resume', conclusion: 'success' }, { name: 'resume-server / manifest', conclusion: 'success' },
    { name: 'resume-server / publish', conclusion: 'failure', steps: [
      ...['Download only the original verified artifact IDs', 'Bind reused desktop packages to original source manifests and hash release files',
        'Package signed updates, verify image closures and reject existing Release'].map(name => ({ name, conclusion: 'success' })),
      { name: 'Publish original candidate', conclusion: 'failure' }
    ] }]
  assert.equal(verifiedPublicationRun(f.repository, f.run, f.jobs, f.changedPaths).run, f.run.id)
  for (let i = 0; i < 3; i++) {
    const damaged = structuredClone(f)
    damaged.jobs[2].steps[i].conclusion = 'skipped'
    assert.throws(() => verifiedPublicationRun(damaged.repository, damaged.run, damaged.jobs, damaged.changedPaths))
  }
  assert.throws(() => verifiedPublicationRun(f.repository, f.run, f.jobs, ['package-lock.json']))
  f.jobs[1].conclusion = 'failure'
  assert.throws(() => verifiedPublicationRun(f.repository, f.run, f.jobs, f.changedPaths))
})

for (const [name, mutate] of [
  ['product edits', f => f.changedPaths.push('apps/server/src/runtime.ts')],
  ['missing source verification', f => f.jobs.find(j => j.name.startsWith('Aggregate')).conclusion = 'failure'],
  ['failed arm64', f => f.jobs.find(j => j.name === 'Server image (arm64)').conclusion = 'failure'],
  ['wrong failed step', f => f.jobs.find(j => j.name === 'Server image (amd64)').steps[0].name = 'Run npm run server:smoke'],
  ['publication already started', f => f.jobs.push({ name: 'server-manifest', conclusion: 'success' })],
  ['expired artifact', f => f.artifacts[0].expired = true],
  ['foreign artifact source', f => f.artifacts[0].workflow_run.head_sha = 'c'.repeat(40)],
  ['foreign artifact run', f => f.artifacts[0].workflow_run.id = 124],
  ['missing artifact', f => f.artifacts.pop()],
  ['duplicate artifact', f => f.artifacts.push(f.artifacts[0])],
  ['missing digest', f => delete f.artifacts[0].digest],
  ['fork source', f => f.run.head_repository.full_name = 'other/Javdex'],
  ['unfinished candidate', f => f.run.status = 'in_progress'],
  ['different workflow', f => f.run.path = '.github/workflows/other.yml']
]) test(`resume rejects ${name}`, () => {
  const f = fixture()
  mutate(f)
  assert.throws(() => resumePlan(f))
})

test('recovery preserves publication guards, candidate identity, checks and all ten assets', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release-resume-server.yml', import.meta.url), 'utf8')
  assert.match(workflow, /ref: \$\{\{ steps\.inspect\.outputs\.source \}\}/)
  assert.match(workflow, /GITHUB_SHA="\$CANDIDATE_SOURCE" npm run server:build/)
  assert.match(workflow, /git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"/)
  assert.ok(!workflow.includes('target_commitish:'))
  assert.match(workflow, /needs\.resume\.outputs\.publishOnly == 'true' && needs\.manifest\.result == 'skipped'/)
  assert.ok(workflow.indexOf('npm run server:build') < workflow.indexOf('git show "$REPAIR_SOURCE:apps/server/src/dualBackendScan.e2e.test.ts"'))
  assert.ok(workflow.indexOf('git restore -- apps/server/src/dualBackendScan.e2e.test.ts') < workflow.indexOf('npm run server:smoke'))
  assert.ok(workflow.indexOf('git -c core.fileMode=false diff --exit-code') < workflow.indexOf('git restore -- apps/server/src/index.ts'))
  for (const command of ['npm run server:test', 'npm run server:updater:test', 'npm run server:updater:smoke', 'npm run server:smoke',
    'node scripts/release-publication.mjs manifest', 'node scripts/release-publication.mjs release', 'node scripts/server-update-release.mjs publish']) assert.ok(workflow.includes(command), command)
  assert.ok(workflow.indexOf('node scripts/release-publication.mjs manifest') < workflow.indexOf('docker buildx imagetools create'))
  assert.ok(workflow.indexOf('node scripts/release-publication.mjs release') < workflow.indexOf('softprops/action-gh-release@'))
  assert.match(workflow, /artifact-ids: \$\{\{ needs\.resume\.outputs\.artifactIds \}\}/)
  assert.match(workflow, /run-id: \$\{\{ inputs\.run_id \}\}/)
  assert.match(workflow, /assert\.equal\(info\.build, process\.env\.CANDIDATE_SOURCE\)/)
  assert.match(workflow, /imagetools inspect.*\{\{\.Manifest\.Digest\}\}/)
  assert.ok(!workflow.includes('.RepoDigests'))
  assert.match(workflow, /Javdex-Playback-Sources-\$\{\{ needs\.resume\.outputs\.version \}\}\.tar\.gz/)
  assert.ok(!workflow.includes('force=true'))
})

for (const damage of ['none', 'installer', 'version', 'extra-package']) test(`actual recovery checksum gate: ${damage}`, t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'javdex-resume-binding-'))
  t.after(() => {
    assert.equal(path.dirname(root), temporaryRoot)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const version = '0.9.1-beta.1', directory = path.join(root, 'release-artifacts')
  const manifests = path.join(root, 'input', 'Playback-Sources', 'manifests')
  fs.mkdirSync(manifests, { recursive: true })
  fs.mkdirSync(directory)
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(new URL('./playback-source-materials.mjs', import.meta.url), path.join(root, 'scripts', 'playback-source-materials.mjs'))
  const byTarget = new Map()
  for (const [fileName, target] of Object.entries(playbackInstallers(version))) {
    const bytes = Buffer.from(`fixture ${fileName}`)
    fs.writeFileSync(path.join(directory, fileName), bytes)
    if (!byTarget.has(target)) byTarget.set(target, [])
    byTarget.get(target).push({ fileName, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const [target, installers] of byTarget) fs.writeFileSync(path.join(manifests, `${target}.json`), JSON.stringify({
    version: damage === 'version' ? '0.9.0' : version, target, installers
  }))
  const packed = spawnSync('tar', ['-czf', path.join(directory, `Javdex-Playback-Sources-${version}.tar.gz`), '-C', path.join(root, 'input'), 'Playback-Sources'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  if (damage === 'installer') fs.appendFileSync(path.join(directory, Object.keys(playbackInstallers(version))[0]), 'changed')
  if (damage === 'extra-package') fs.writeFileSync(path.join(directory, 'unverified.exe'), 'extra')
  const workflow = fs.readFileSync(new URL('../.github/workflows/release-resume-server.yml', import.meta.url), 'utf8')
  const code = workflow.match(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/)[1].replace(/^ {10}/gm, '')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, VERSION: version } })
  if (damage === 'none') {
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 7)
  } else {
    assert.notEqual(result.status, 0)
    assert.equal(fs.existsSync(path.join(directory, 'SHA256SUMS.txt')), false)
  }
})
