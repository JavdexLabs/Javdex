import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import {
  assertTrustedIpcSender,
  configureIpcSecurity,
  isSameRendererLocation,
  resetIpcSecurityForTests
} from './ipcSecurity'

interface SecurityFixture {
  event: IpcMainInvokeEvent
  window: BrowserWindow
  sender: WebContents
  frame: WebFrameMain
}

function createFixture(url = 'http://127.0.0.1:5173/settings'): SecurityFixture {
  const frame = { url } as WebFrameMain
  const sender = { mainFrame: frame } as WebContents
  const window = {
    isDestroyed: () => false,
    webContents: sender
  } as BrowserWindow
  const event = { sender, senderFrame: frame } as IpcMainInvokeEvent
  return { event, window, sender, frame }
}

afterEach(() => resetIpcSecurityForTests())

describe('IPC sender security', () => {
  it('accepts the configured main window and main frame', () => {
    const fixture = createFixture()
    configureIpcSecurity({
      getWindow: () => fixture.window,
      isTrustedUrl: (url) => isSameRendererLocation(url, 'http://127.0.0.1:5173')
    })

    assert.doesNotThrow(() => assertTrustedIpcSender(fixture.event))
  })

  it('rejects another webContents, a child frame, and an untrusted URL', () => {
    const fixture = createFixture()
    configureIpcSecurity({
      getWindow: () => fixture.window,
      isTrustedUrl: (url) => isSameRendererLocation(url, 'http://127.0.0.1:5173')
    })

    assert.throws(
      () => assertTrustedIpcSender({ ...fixture.event, sender: {} as WebContents }),
      /非主窗口/
    )
    assert.throws(
      () =>
        assertTrustedIpcSender({
          ...fixture.event,
          senderFrame: { url: fixture.frame.url } as WebFrameMain
        }),
      /非主页面/
    )
    const untrusted = createFixture('https://example.com')
    configureIpcSecurity({
      getWindow: () => untrusted.window,
      isTrustedUrl: (url) => isSameRendererLocation(url, 'http://127.0.0.1:5173')
    })
    assert.throws(() => assertTrustedIpcSender(untrusted.event), /非受信页面/)
  })

  it('matches dev origins but requires the exact production file', () => {
    assert.equal(
      isSameRendererLocation('http://localhost:5173/settings?tab=scan', 'http://localhost:5173'),
      true
    )
    assert.equal(
      isSameRendererLocation('http://localhost:5174', 'http://localhost:5173'),
      false
    )
    assert.equal(
      isSameRendererLocation('file:///app/index.html#/settings', 'file:///app/index.html'),
      true
    )
    assert.equal(
      isSameRendererLocation('file:///app/other.html', 'file:///app/index.html'),
      false
    )
  })
})
