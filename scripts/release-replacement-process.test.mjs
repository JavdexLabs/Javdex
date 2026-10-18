import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { replacementBaseline } from './release-replacement.mjs'

// Mock only GitHub/registry/CLI ports. Execute the real cutover and recovery program.
const preload = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(path.join(process.cwd(), 'fixture.cjs'));
const state = JSON.parse(fs.readFileSync(process.env.REPLACEMENT_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.REPLACEMENT_STATE, JSON.stringify(state));
const fail = point => {
  if (state.failOn === point && !state.failed) { state.failed = true; save(); throw Error('injected ' + point); }
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input)), method = init.method || 'GET';
  state.calls.push([method, url.pathname]);
  if (url.hostname === 'ghcr.io') {
    if (url.pathname === '/token') return Response.json({ token: 'fixture-read-token' });
    if (method !== 'HEAD') throw Error('No image bodies may be downloaded by this program');
    const tag = url.pathname.split('/manifests/')[1], digest = state.images[tag];
    return new Response(null, { status: digest ? 200 : 404, headers: digest ? { 'docker-content-digest': digest } : {} });
  }
  if (url.hostname !== 'api.github.com') throw Error('Unexpected host');
  const endpoint = decodeURIComponent(url.pathname.split('/repos/JavdexLabs/Javdex/')[1]);
  const body = init.body ? JSON.parse(init.body) : {};
  let result, status = 200;
  if (endpoint === 'releases' && method === 'GET') result = state.releases;
  else if (endpoint === 'releases' && method === 'POST') {
    result = { ...body, id: 9001, immutable: false, assets: [] }; state.releases.push(result); status = 201;
  } else if (endpoint.startsWith('releases/tags/')) {
    result = state.releases.find(release => !release.draft && release.tag_name === endpoint.slice(14));
  } else if (endpoint === 'releases/latest') {
    fail('verify'); result = state.releases.find(release => !release.draft);
  } else if (/^releases\/\d+/.test(endpoint)) {
    const id = Number(endpoint.split('/')[1]); result = state.releases.find(release => release.id === id);
    if (method === 'PATCH') {
      Object.assign(result, body);
      if (id === 416016386 && body.draft === true) fail('archive');
      if (id === 9001 && body.draft === false) fail('publish');
      if (id === 9001 && body.draft === false && state.failOn === 'foreign-original') {
        state.releases.find(release => release.id === 416016386).body = 'changed by another owner'; fail('foreign-original');
      }
    }
    if (endpoint.endsWith('/assets')) result = result.assets;
  } else if (endpoint.startsWith('git/ref/tags/')) {
    const sha = state.tags[endpoint.slice(13)]; if (sha) result = { object: { type: 'commit', sha } };
  } else if (endpoint === 'git/refs' && method === 'POST') {
    state.tags[body.ref.slice(10)] = body.sha; result = { object: { type: 'commit', sha: body.sha } }; status = 201;
  } else throw Error('Unexpected endpoint: ' + endpoint);
  save(); return Response.json(result || {}, { status: result ? status : 404 });
};
require('node:child_process').execFileSync = (program, args) => {
  state.commands.push([program, args]);
  if (program === 'gh' && args[0] === 'release' && args[1] === 'upload') {
    const release = state.releases.find(release => release.id === 9001);
    release.assets = args.slice(5).map((filename, index) => {
      const bytes = fs.readFileSync(filename);
      return { id: 10000 + index, name: path.basename(filename), size: bytes.length,
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
    });
  } else if (program === 'git') {
    const lease = args.find(arg => arg.startsWith('--force-with-lease=')).split(':').at(-1);
    if (state.tags['v0.9.0'] !== lease) throw Error('lease mismatch');
    state.tags['v0.9.0'] = args.at(-1).split(':')[0]; fail('tag');
  } else if (program === 'docker') {
    const tag = args[args.indexOf('-t') + 1].split(':').at(-1);
    state.images[tag] = args.at(-1).split('@')[1];
    if (tag === '0.9.0') fail('image');
  } else throw Error('Unexpected process: ' + program);
  save(); return '';
};
syncBuiltinESMExports();
process.on('exit', save);
`

test('the real publication program preserves old assets through successful and interrupted complete cutovers', async t => {
  const original = JSON.parse(await fs.readFile(new URL('./fixtures/replacement-0.9.0-original.json', import.meta.url), 'utf8'))
  for (const failure of [undefined, 'archive', 'tag', 'image', 'publish', 'verify', 'foreign-original']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-replacement-process-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const outputs = path.join(directory, 'release-artifacts'), stateFile = path.join(directory, 'state.json')
    await fs.mkdir(outputs)
    const sums = []
    for (const asset of replacementBaseline.assets.filter(asset => asset.name !== 'SHA256SUMS.txt')) {
      const bytes = Buffer.from('new fixture ' + asset.name)
      await fs.writeFile(path.join(outputs, asset.name), bytes)
      sums.push(createHash('sha256').update(bytes).digest('hex') + '  ' + asset.name)
    }
    await fs.writeFile(path.join(outputs, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
    await fs.writeFile(path.join(directory, 'release-body.md'), 'New fixture release notes')
    const candidate = 'a'.repeat(40), image = 'sha256:' + 'f'.repeat(64)
    await fs.writeFile(stateFile, JSON.stringify({ releases: [original.release], tags: { 'v0.9.0': original.tag.sha },
      images: { '0.9.0': original.imageDigest, 'staged-1234-1': image }, calls: [], commands: [], failOn: failure }))
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL('./release-replacement-publish.mjs', import.meta.url))], { cwd: directory, encoding: 'utf8',
      env: { ...process.env, REPLACEMENT_STATE: stateFile, GITHUB_REPOSITORY: 'JavdexLabs/Javdex', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_SHA: candidate, GITHUB_TOKEN: 'fixture-not-a-credential', RELEASE_REPLACE_090: 'true', RELEASE_TAG: 'v0.9.0',
        RELEASE_REPLACEMENT_SOURCE: candidate, RELEASE_VERIFY_ONLY: 'false', RELEASE_PRERELEASE: 'false', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1' } })
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    if (failure) {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp('injected ' + failure))
      if (failure === 'foreign-original') {
        assert.match(result.stderr, /recovery requires attention/)
        assert.equal(state.releases.find(release => release.id === 416016386).body, 'changed by another owner')
        assert.equal(state.tags['v0.9.0'], candidate)
      } else {
        assert.equal(state.tags['v0.9.0'], original.tag.sha)
        assert.equal(state.images['0.9.0'], original.imageDigest)
        assert.equal(state.releases.find(release => release.id === 416016386).draft, false)
      }
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(state.tags['v0.9.0'], candidate); assert.equal(state.images['0.9.0'], image)
      assert.equal(state.releases.find(release => release.id === 9001).draft, false)
      assert.equal(state.releases.find(release => release.id === 416016386).draft, true)
    }
    assert.deepEqual(state.releases.find(release => release.id === 416016386).assets, original.release.assets)
    assert.equal(state.releases.find(release => release.id === 9001).assets.length, 10)
    assert.equal(state.tags['archive/0.9.0/original-' + original.tag.sha], original.tag.sha)
    assert.equal(state.images['archive-0.9.0-' + original.tag.sha], original.imageDigest)
  }
})
