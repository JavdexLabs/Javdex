import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateServerEnvironment, type ServerEnvironmentInfo } from './serverEnvironment'

test('server environment upgrades require equality rather than a minimum version', () => {
  const info: ServerEnvironmentInfo = { format: 1, environmentVersion: 2, runtimeId: 'node22-bookworm-v1', platform: 'linux/amd64' }
  assert.equal(evaluateServerEnvironment(info, 2).state, 'compatible')
  assert.equal(evaluateServerEnvironment(info, 3).state, 'imageRequired')
  assert.equal(evaluateServerEnvironment(info, 1).state, 'clientRequired')
  assert.equal(evaluateServerEnvironment(null, 2).state, 'imageRequired')
  assert.equal(evaluateServerEnvironment(null, 2).currentVersion, null)
  assert.equal(evaluateServerEnvironment(info, 3).message, '需要升级服务端Docker镜像')
})
