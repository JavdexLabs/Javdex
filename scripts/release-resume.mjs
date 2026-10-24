import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { assertReleaseAvailable } from './release-publication.mjs'

const reusableJobs = ['metadata', 'Typecheck and test', 'Package win-x64', 'Package mac-x64',
  'Package mac-arm64', 'Package linux-x64', 'Aggregate corresponding playback sources', 'Server image (arm64)']
const reusableArtifacts = ['Javdex-win-x64', 'Javdex-mac-x64', 'Javdex-mac-arm64', 'Javdex-linux-x64', 'Playback-Sources-Combined']
// Recovery changes the validation harness, never the candidate being shipped.
const repairPaths = new Set(['apps/server/src/dualBackendScan.e2e.test.ts', '.github/workflows/release.yml',
  '.github/workflows/release-resume-server.yml', 'scripts/release-resume.mjs', 'scripts/release-resume.test.mjs',
  'docs/VERSIONING_AND_RELEASE.md'])

export function resumePlan({ repository, run, jobs, artifacts, changedPaths }) {
  assert.equal(run.repository?.full_name, repository, 'Foreign candidate repository')
  assert.equal(run.head_repository?.full_name, repository, 'Fork candidates cannot be resumed')
  assert.equal(run.path, '.github/workflows/release.yml', 'Expected original Release workflow')
  assert.equal(run.status, 'completed', 'Candidate must be complete')
  assert.equal(run.conclusion, 'failure', 'Only an unpublished failed candidate can be resumed')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0)
  const job = name => {
    const found = jobs.filter(j => j.name === name)
    assert.equal(found.length, 1, `Expected one job: ${name}`)
    return found[0]
  }
  for (const name of reusableJobs) assert.equal(job(name).conclusion, 'success', `Unverified prerequisite: ${name}`)
  const failed = job('Server image (amd64)')
  assert.equal(failed.conclusion, 'failure')
  assert.deepEqual(failed.steps.filter(s => s.conclusion === 'failure').map(s => s.name), ['Run npm run server:test'])
  assert.ok(jobs.filter(j => j.conclusion === 'failure').every(j => j.name === failed.name), 'Other failed jobs require normal recovery')
  for (const name of ['server-manifest', 'Publish GitHub release']) {
    assert.ok(jobs.filter(j => j.name === name).every(j => j.conclusion === 'skipped'), 'Publication has already started')
  }
  assert.ok(changedPaths.every(name => repairPaths.has(name)), 'Product source changed; rebuild from the new candidate')
  const selected = reusableArtifacts.map(name => {
    const found = artifacts.filter(a => a.name === name)
    assert.equal(found.length, 1, `Expected one artifact: ${name}`)
    const artifact = found[0]
    assert.equal(artifact.expired, false, `Expired artifact: ${name}`)
    assert.equal(artifact.workflow_run?.head_sha, run.head_sha, 'Artifact source mismatch')
    assert.equal(artifact.workflow_run?.id, run.id, 'Artifact run mismatch')
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.size_in_bytes > 0)
    return artifact
  })
  return { source: run.head_sha, baseRun: run.id, baseAttempt: run.run_attempt, artifacts: selected }
}

async function inspect() {
  const repository = process.env.GITHUB_REPOSITORY
  const id = process.env.RESUME_RUN_ID
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/)
  assert.match(id ?? '', /^[1-9][0-9]{0,15}$/)
  async function api(suffix) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000)
    })
    assert.equal(response.status, 200, `Candidate API HTTP ${response.status}`)
    return response.json()
  }
  const [run, jobResult, artifactResult] = await Promise.all([api(`actions/runs/${id}`),
    api(`actions/runs/${id}/jobs?filter=latest&per_page=100`), api(`actions/runs/${id}/artifacts?per_page=100`)])
  assert.ok(jobResult.total_count <= 100 && artifactResult.total_count <= 100, 'Incomplete candidate inventory')
  execFileSync('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD'])
  const changedPaths = execFileSync('git', ['diff', '--name-only', run.head_sha, 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const plan = resumePlan({ repository, run, jobs: jobResult.jobs, artifacts: artifactResult.artifacts, changedPaths })
  const { version } = JSON.parse(execFileSync('git', ['show', `${plan.source}:package.json`], { encoding: 'utf8' }))
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
  const tag = process.env.RELEASE_TAG || `v${version}`
  assert.equal(tag, `v${version}`)
  const image = `ghcr.io/${repository.split('/')[0].toLowerCase()}/javdex-server`
  await assertReleaseAvailable({ tag, version, image, env: { ...process.env, GITHUB_SHA: plan.source } })
  const outputs = { source: plan.source, version, tag, image, prerelease: version.includes('-') || process.env.RELEASE_PRERELEASE === 'true',
    artifactIds: plan.artifacts.map(a => a.id).join(','), armImage: `${image}:build-${plan.baseRun}-${plan.baseAttempt}-arm64` }
  fs.mkdirSync('out', { recursive: true })
  fs.writeFileSync('out/release-resume-receipt.json', JSON.stringify({ ...plan, repairSource: process.env.GITHUB_SHA, changedPaths }, null, 2) + '\n')
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
  console.log(`Resume ${tag} from original source ${plan.source}; reuse ${plan.artifacts.length} verified artifacts and arm64.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await inspect()
