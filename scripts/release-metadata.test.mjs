import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseMetadata } from './release-metadata.mjs'
import { readFileSync } from 'node:fs'

test('beta tags are prereleases even without a manual flag', () => {
  assert.deepEqual(releaseMetadata('0.8.0-beta.1', 'v0.8.0-beta.1'), {
    tag: 'v0.8.0-beta.1', version: '0.8.0-beta.1', prerelease: true
  })
  assert.deepEqual(releaseMetadata('0.9.0-beta.1', 'v0.9.0-beta.1'), {
    tag: 'v0.9.0-beta.1', version: '0.9.0-beta.1', prerelease: true
  })
})
test('stable and manually marked prereleases retain their channel', () => {
  assert.equal(releaseMetadata('0.8.0').prerelease, false)
  assert.equal(releaseMetadata('0.8.0', undefined, true).prerelease, true)
})
test('Beta.3 uses a new prerelease tag without replacing earlier betas', () => {
  assert.deepEqual(releaseMetadata('0.9.0-beta.3', ''), {
    tag: 'v0.9.0-beta.3', version: '0.9.0-beta.3', prerelease: true
  })
  assert.throws(() => releaseMetadata('0.9.0-beta.3', 'v0.9.0-beta.1'))
  assert.throws(() => releaseMetadata('0.9.0-beta.3', 'v0.9.0-beta.2'))
})
test('mismatched or unsafe tags fail before publishing', () => {
  assert.throws(() => releaseMetadata('0.8.0', 'v0.7.1'))
  assert.throws(() => releaseMetadata('0.8.0', 'v0.8.0\nlatest'))
})

// Git checks out CRLF on Windows. Assert identical workflow requirements for
// both line-ending representations rather than depending on the test host.
for (const [lineEnding, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
    .replace(/\r?\n/g, eol).replace(/\r\n/g, '\n')

  test(`release packaging gates playback resources and delivers corresponding sources with checksums (${lineEnding})`, () => {
    assert.match(workflow, /run: npm run packaging:verify-playback-runtime/)
    assert.match(workflow, /run: node scripts\/check-playback-installers\.mjs dist/)
    assert.match(workflow, /dist\/Javdex-Playback-Sources-\*\.tar\.gz\.installers\.json/)
    assert.match(workflow, /dist\/Javdex-Playback-Sources-\*\.tar\.gz/)
    assert.match(workflow, /run: node scripts\/aggregate-playback-sources\.mjs source-artifacts/)
    assert.match(workflow, /dist\/Javdex-Playback-Sources-\*\.tar\.gz\.runtime\.json/)
    assert.match(workflow, /release-artifacts\/Javdex-Playback-Sources-\$\{\{ needs\.metadata\.outputs\.version \}\}\.tar\.gz/)
    assert.ok(workflow.includes('sha256sum -- "Javdex-Playback-Sources-$VERSION.tar.gz"'))
    assert.match(workflow, /needs: \[metadata, package, playback-sources\]/)
    const attachments = workflow.split('files: |')[1]
    for (const name of ['docker-compose.example.yml', 'javdex-server.example.json', 'server-update-public.pem']) assert.ok(!attachments.includes(name))
    assert.ok(attachments.includes('release-artifacts/Javdex-server-*.javdex-update'))
    assert.ok(!attachments.includes('Javdex-server-update-*.json') && !attachments.includes('Javdex-server-*.tar.gz'))
  })

  test(`release builds each playback architecture from source before packaging (${lineEnding})`, () => {
    const build = workflow.indexOf('run: npm run playback:runtime:build\n')
    const packaging = workflow.indexOf('- name: Package\n')
    assert.ok(build >= 0 && build < packaging, 'source runtime construction must run before electron-builder')
    assert.match(workflow, /JAVDEX_PLAYBACK_RUNTIME_DIR:/)
    assert.match(workflow, /macos-15-intel/)
    assert.match(workflow, /--arch \$\{\{ matrix\.arch \}\}/)
    assert.match(workflow, /steps\.playback_fingerprint\.outputs\.fingerprint/)
    assert.ok(workflow.indexOf('-- --fingerprint') < workflow.indexOf('uses: actions/cache@v4'), 'compiler/SDK fingerprint must precede cache restore')
    assert.match(workflow, /- platform: win\n\s+os: windows-2022\n\s+arch: x64/)
    assert.match(workflow, /id: msys2\n\s+uses: msys2\/setup-msys2@v2/)
    for (const name of ['Identify playback source/toolchain cache', 'Build playback runtime from pinned source']) {
      const block = workflow.split(`- name: ${name}\n`)[1]?.split('\n      - ')[0]
      assert.ok(block?.includes('JAVDEX_PLAYBACK_MSYS2_ROOT: ${{ steps.msys2.outputs.msys2-location }}'), 'fingerprint and build must use the same action-installed toolchain')
    }
  })

  test(`verification-only runs cannot enter any publishing job (${lineEnding})`, () => {
    assert.match(workflow, /verify_only:\s+description:.*\n\s+required: false\n\s+default: false\n\s+type: boolean/)
    for (const name of ['server', 'server-manifest', 'release']) {
      const block = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0]
      assert.ok(block && /if:.*!inputs\.verify_only/.test(block), `${name} must reject verification-only dispatches`)
    }
  })

  test(`release workflow cannot force-move existing tags (${lineEnding})`, () => {
    assert.ok(!workflow.includes('overwrite_beta1'))
    assert.ok(!workflow.includes('force=true'))
    assert.ok(!workflow.includes('git/refs/tags/'))
  })
}
