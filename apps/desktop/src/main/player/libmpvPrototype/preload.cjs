const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('playerProbe', {
  initialize: (bounds) => ipcRenderer.invoke('mpv-probe:initialize', bounds),
  bounds: (bounds) => ipcRenderer.invoke('mpv-probe:bounds', bounds),
  source: (id) => ipcRenderer.invoke('mpv-probe:source', id),
  action: (action, value) => ipcRenderer.invoke('mpv-probe:action', action, value),
  overlay: (visible) => ipcRenderer.invoke('mpv-probe:overlay', visible),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('mpv-probe:state', listener)
    return () => ipcRenderer.removeListener('mpv-probe:state', listener)
  }
})
