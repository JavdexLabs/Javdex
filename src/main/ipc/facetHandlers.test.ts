import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IpcChannel } from '@shared/ipc-channels'
import { IPC } from '@shared/ipc-channels'
import type { ClassificationQueryService } from '../services/classificationQueryService'
import type { ClassificationMaintenanceService } from '../services/classificationMaintenanceService'
import { appCommandAdapter } from './appContractAdapter'
import { registerOrganizationHandlers } from './facetHandlers'

describe('organization IPC contract', () => {
  it('registers every command and forwards typed arguments to the public services', () => {
    const calls: unknown[] = []
    const queryService: ClassificationQueryService = {
      listOrganizations(query) {
        calls.push(['list', query])
        return []
      },
      getOrganization(id, role) {
        calls.push(['get', id, role])
        return null
      },
      listOrganizationOptions(search) {
        calls.push(['options', search])
        return []
      }
    }
    const maintenanceService: ClassificationMaintenanceService = {
      createOrganization(input) {
        calls.push(['create', input])
        return 17
      },
      updateOrganization(id, input) {
        calls.push(['update', id, input])
        return true
      },
      assignVideoOrganization() {
        throw new Error('not used by organization IPC')
      }
    }
    const handlers = new Map<IpcChannel, (...args: unknown[]) => unknown>()
    const adapter = {
      register(channel: IpcChannel, handler: (...args: unknown[]) => unknown) {
        handlers.set(channel, handler)
      }
    } as typeof appCommandAdapter

    registerOrganizationHandlers(adapter, { queryService, maintenanceService })

    const listQuery = { role: 'maker' as const, search: 'studio' }
    const createInput = { role: 'publisher' as const, mainName: 'Studio' }
    const updateInput = { mainName: 'Renamed' }
    assert.deepEqual(handlers.get(IPC.ORGANIZATION_LIST)?.(listQuery), [])
    assert.equal(handlers.get(IPC.ORGANIZATION_GET)?.(12, 'publisher'), null)
    assert.deepEqual(handlers.get(IPC.ORGANIZATION_OPTIONS)?.('alias'), [])
    assert.equal(handlers.get(IPC.ORGANIZATION_CREATE)?.(createInput), 17)
    assert.equal(handlers.get(IPC.ORGANIZATION_UPDATE)?.(12, updateInput), true)
    assert.deepEqual(calls, [
      ['list', listQuery],
      ['get', 12, 'publisher'],
      ['options', 'alias'],
      ['create', createInput],
      ['update', 12, updateInput]
    ])
  })
})
