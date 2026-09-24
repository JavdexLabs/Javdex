import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseMetadata } from './release-metadata.mjs'

test('beta tags are prereleases even without a manual flag', () => {
  assert.deepEqual(releaseMetadata('0.8.0-beta.1', 'v0.8.0-beta.1'), {
    tag: 'v0.8.0-beta.1', version: '0.8.0-beta.1', prerelease: true
  })
})
test('stable and manually marked prereleases retain their channel', () => {
  assert.equal(releaseMetadata('0.8.0').prerelease, false)
  assert.equal(releaseMetadata('0.8.0', undefined, true).prerelease, true)
})
test('mismatched or unsafe tags fail before publishing', () => {
  assert.throws(() => releaseMetadata('0.8.0', 'v0.7.1'))
  assert.throws(() => releaseMetadata('0.8.0', 'v0.8.0\nlatest'))
})
