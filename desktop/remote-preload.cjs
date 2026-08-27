'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshRemote', {
  getStatus: () => ipcRenderer.invoke('remote:get-status'),
  enable: () => ipcRenderer.invoke('remote:enable'),
  disable: () => ipcRenderer.invoke('remote:disable'),
  createPairing: () => ipcRenderer.invoke('remote:create-pairing'),
  approvePairing: (pairingId) => ipcRenderer.invoke('remote:approve-pairing', pairingId),
  revokeDevice: (deviceId) => ipcRenderer.invoke('remote:revoke-device', deviceId),
  onStatus: (listener) => {
    const wrapped = (_event, value) => listener(value)
    ipcRenderer.on('remote:status', wrapped)
    return () => ipcRenderer.removeListener('remote:status', wrapped)
  },
  onPairing: (listener) => {
    const wrapped = (_event, value) => listener(value)
    ipcRenderer.on('remote:pairing', wrapped)
    return () => ipcRenderer.removeListener('remote:pairing', wrapped)
  }
})
