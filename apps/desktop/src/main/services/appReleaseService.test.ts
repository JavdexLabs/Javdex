import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareReleaseVersions,
  normalizeGitHubRelease,
  normalizePersistedUpdateState,
  parseReleaseVersion
} from './appReleaseService'

describe('app release service', () => {
  it('parses and compares stable release versions numerically', () => {
    assert.deepEqual(parseReleaseVersion('v0.10.2'), [0, 10, 2])
    assert.equal(parseReleaseVersion('v1.2.3-beta.1'), null)
    assert.equal(compareReleaseVersions('0.10.0', '0.9.0'), 1)
    assert.equal(compareReleaseVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareReleaseVersions('0.3.9', '0.4.0'), -1)
  })

  it('accepts only trusted published GitHub releases', () => {
    const valid = {
      tag_name: 'v0.4.0',
      name: 'Javdex v0.4.0',
      html_url: 'https://github.com/JavdexLabs/Javdex/releases/tag/v0.4.0',
      published_at: '2026-07-12T00:00:00Z',
      body: 'Release notes',
      draft: false,
      prerelease: false
    }
    assert.equal(normalizeGitHubRelease(valid)?.version, '0.4.0')
    assert.equal(normalizeGitHubRelease({ ...valid, draft: true }), null)
    assert.equal(normalizeGitHubRelease({ ...valid, prerelease: true }), null)
    assert.equal(normalizeGitHubRelease({ ...valid, tag_name: 'latest' }), null)
    assert.equal(
      normalizeGitHubRelease({
        ...valid,
        html_url: 'https://github.com/attacker/repo/releases/tag/v0.4.0'
      }),
      null
    )
  })

  it('validates cached update state before exposing it to the renderer', () => {
    const validRelease = {
      version: '0.4.0',
      tagName: 'v0.4.0',
      releaseName: 'Javdex v0.4.0',
      releaseUrl: 'https://github.com/JavdexLabs/Javdex/releases/tag/v0.4.0',
      publishedAt: '2026-07-12T00:00:00Z',
      releaseNotes: 'Release notes'
    }
    assert.deepEqual(
      normalizePersistedUpdateState({
        lastCheckedAt: '2026-07-12T01:00:00Z',
        ignoredVersion: 'v0.4.0',
        cachedRelease: validRelease
      }),
      {
        lastCheckedAt: '2026-07-12T01:00:00Z',
        ignoredVersion: '0.4.0',
        cachedRelease: validRelease
      }
    )

    assert.deepEqual(
      normalizePersistedUpdateState({
        lastCheckedAt: 'not-a-date',
        ignoredVersion: 'latest',
        cachedRelease: { ...validRelease, releaseNotes: 1 }
      }),
      {}
    )
  })
})
