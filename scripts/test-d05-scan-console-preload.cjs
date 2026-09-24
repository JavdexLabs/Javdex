const { contextBridge, ipcRenderer } = require('electron')

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res || res.ok !== true) {
    const message = res?.error?.message || 'IPC 调用失败'
    throw new Error(message)
  }
  return res.data
}

function onEvent(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  scan: {
    run: (libraryId, rootIds) => invoke('scan:run', libraryId, rootIds),
    cancel: (runId) => invoke('scan:cancel', runId),
    getAuditHeader: (libraryId) => invoke('scan:auditHeader', libraryId),
    onProgress: (cb) => onEvent('scan:progress', cb),
    onStateChanged: (cb) => onEvent('scan:stateChanged', cb)
  }
})
