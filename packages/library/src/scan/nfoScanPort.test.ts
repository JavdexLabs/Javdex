import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  configureLocalNfoScanService,
  getConfiguredLocalNfoScanService,
  resetLocalNfoScanServiceForTests,
  type LocalNfoScanService
} from './nfoScanPort'

const stub: LocalNfoScanService = {
  inspectIdentity: () => ({ status: 'missing', code: null, warnings: [] }),
  apply: async () => ({ disposition: 'none', warnings: [] })
}

describe('local NFO scan port', () => {
  afterEach(() => {
    resetLocalNfoScanServiceForTests()
  })

  it('requires an explicit host service', () => {
    assert.throws(
      () => getConfiguredLocalNfoScanService(),
      /Local NFO scan service is not configured/
    )
  })

  it('returns the configured service', () => {
    configureLocalNfoScanService(stub)
    assert.equal(getConfiguredLocalNfoScanService(), stub)
  })
})
