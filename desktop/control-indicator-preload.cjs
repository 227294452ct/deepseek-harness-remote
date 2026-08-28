'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktopControl', {
  stop: () => ipcRenderer.invoke('remote:stop-desktop-control'),
  onState: listener => {
    const wrapped = (_event, state) => listener(state)
    ipcRenderer.on('remote:desktop-control', wrapped)
    return () => ipcRenderer.removeListener('remote:desktop-control', wrapped)
  }
})
