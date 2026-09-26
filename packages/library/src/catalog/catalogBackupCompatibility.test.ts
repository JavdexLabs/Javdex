import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareBackupVersions } from './catalogBackupCompatibility'

test('backup versions follow release and prerelease precedence', () => {
  const versions = ['0.7.1', '0.8.0-alpha', '0.8.0-alpha.1', '0.8.0-beta.2', '0.8.0-beta.10', '0.8.0-rc.1', '0.8.0', '0.8.1', '0.10.0', '1.0.0']
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareBackupVersions(versions[i - 1], versions[i]), -1)
    assert.equal(compareBackupVersions(versions[i], versions[i - 1]), 1)
  }
  assert.equal(compareBackupVersions('0.8.0+old', '0.8.0+new'), 0)
  assert.equal(compareBackupVersions('test', 'test'), 0)
  assert.throws(() => compareBackupVersions('unknown', '0.8.0'))
  assert.throws(() => compareBackupVersions('0.8.0-beta.01', '0.8.0'))
})
