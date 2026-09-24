import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WebAccessStatus } from '@shared/webTypes'
import {
  compactWebAccessUrl,
  preferredWebAccessUrl,
  webAccessOverviewStatus
} from './settingsDisplay'

function status(patch: Partial<WebAccessStatus>): WebAccessStatus {
  return {
    enabled: false,
    running: false,
    port: 8096,
    username: 'viewer',
    hasPassword: true,
    urls: [],
    devices: [],
    pairingUntil: 0,
    pairingActivity: [],
    sessions: 0,
    error: null,
    ...patch
  }
}

describe('webAccessOverviewStatus', () => {
  it('prefers a LAN URL over loopback', () => {
    assert.equal(
      preferredWebAccessUrl(['http://127.0.0.1:8096', 'http://192.168.1.20:8096']),
      'http://192.168.1.20:8096'
    )
    assert.equal(compactWebAccessUrl('http://192.168.1.20:8096'), '192.168.1.20:8096')
    assert.equal(compactWebAccessUrl('http://127.0.0.1:8096'), '仅本机 · 127.0.0.1:8096')
  })

  it('summarizes loading, running, disabled and failed states', () => {
    assert.deepEqual(webAccessOverviewStatus({ status: null, error: null }), {
      value: '读取中…',
      detail: '正在读取服务状态',
      attention: false
    })
    assert.deepEqual(
      webAccessOverviewStatus({
        status: status({
          enabled: true,
          running: true,
          urls: ['http://127.0.0.1:8096', 'http://192.168.1.20:8096']
        }),
        error: null
      }),
      {
        value: '运行中',
        detail: '192.168.1.20:8096',
        attention: false,
        hint: 'http://192.168.1.20:8096'
      }
    )
    assert.deepEqual(webAccessOverviewStatus({ status: status({ enabled: false }), error: null }), {
      value: '已关闭',
      detail: '未启用',
      attention: false
    })
    assert.deepEqual(
      webAccessOverviewStatus({
        status: status({ enabled: true, running: false, error: '端口被占用' }),
        error: null
      }),
      { value: '启动失败', detail: '端口被占用', attention: true }
    )
    assert.deepEqual(webAccessOverviewStatus({ status: null, error: '无法连接主进程' }), {
      value: '读取失败',
      detail: '无法连接主进程',
      attention: true
    })
  })
})
