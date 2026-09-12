import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRemoteSessionCapabilities } from './desktopCapabilities'

describe('createRemoteSessionCapabilities', () => {
  it('keeps desktop tools available while naming the session failure', () => {
    const disconnected = createRemoteSessionCapabilities('disconnected')
    assert.equal(disconnected.editCatalog.allowed, false)
    assert.equal(disconnected.editCatalog.reason, 'disconnected')
    assert.equal(disconnected.playLocalFile.reason, 'remoteMode')
    assert.equal(disconnected.runPlugins.allowed, true)
    const mismatch = createRemoteSessionCapabilities('versionMismatch')
    assert.equal(mismatch.editCatalog.reason, 'versionMismatch')
    const recovery = createRemoteSessionCapabilities('recoveryRequired')
    assert.equal(recovery.editCatalog.reason, 'recoveryRequired')
    const frozen = createRemoteSessionCapabilities('frozen', true)
    assert.equal(frozen.editCatalog.allowed, false)
    assert.equal(frozen.editCatalog.reason, 'catalogFrozen')
    assert.equal(frozen.playRemoteFile.allowed, true)
  })
})
