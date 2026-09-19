import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLocalDesktopCapabilities, createRemoteSessionCapabilities } from './desktopCapabilities'
import { DESKTOP_CAPABILITY_ACTIONS } from '@shared/desktop/capabilities'
import type { DesktopSessionState } from '@shared/desktop/session'

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
    assert.equal(frozen.manageBrowserPairing.allowed, false)
    assert.equal(frozen.manageBrowserPairing.reason, 'catalogFrozen')
    assert.equal(frozen.playRemoteFile.allowed, true)
    assert.equal(frozen.migrateCatalog.allowed, true)
    assert.equal(frozen.migrateCatalog.reason, 'available')
  })

  it('names every capability action for local and remote session states', () => {
    const local = createLocalDesktopCapabilities()
    assert.deepEqual(Object.keys(local).sort(), [...DESKTOP_CAPABILITY_ACTIONS].sort())
    for (const action of DESKTOP_CAPABILITY_ACTIONS) {
      if (action === 'playRemoteFile') {
        assert.equal(local[action].allowed, false)
        assert.equal(local[action].reason, 'localMode')
        continue
      }
      assert.equal(local[action].allowed, true)
      assert.equal(local[action].reason, 'available')
    }

    const available = createRemoteSessionCapabilities('available')
    assert.equal(available.editCatalog.allowed, true)
    assert.equal(available.playRemoteFile.allowed, true)
    assert.equal(available.runPlugins.allowed, true)
    assert.equal(available.playLocalFile.allowed, false)
    assert.equal(available.playLocalFile.reason, 'remoteMode')
    assert.equal(available.migrateCatalog.allowed, true)
    assert.equal(available.migrateCatalog.reason, 'available')
    assert.equal(available.manageBrowserPairing.allowed, true)
    assert.equal(available.manageBrowserPairing.reason, 'available')

    const frozen = createRemoteSessionCapabilities('frozen', true)
    assert.equal(frozen.editCatalog.allowed, false)
    assert.equal(frozen.editCatalog.reason, 'catalogFrozen')
    assert.equal(frozen.manageBrowserPairing.allowed, false)
    assert.equal(frozen.manageBrowserPairing.reason, 'catalogFrozen')
    assert.equal(frozen.playRemoteFile.allowed, true)
    assert.equal(frozen.migrateCatalog.allowed, true)

    const expectedFailure: Record<string, string> = {
      disconnected: 'disconnected',
      versionMismatch: 'versionMismatch',
      recoveryRequired: 'recoveryRequired',
      authInvalid: 'writerRevoked',
      modePrepRequired: 'needsLocalPrep'
    }
    for (const [state, reason] of Object.entries(expectedFailure)) {
      const caps = createRemoteSessionCapabilities(state as DesktopSessionState)
      assert.equal(caps.editCatalog.allowed, false)
      assert.equal(caps.editCatalog.reason, reason)
      assert.equal(caps.manageBrowserPairing.allowed, false)
      assert.equal(caps.manageBrowserPairing.reason, reason)
      assert.equal(caps.runAgents.allowed, true)
      assert.equal(caps.revealLocalFile.reason, 'remoteMode')
    }
  })
})
