'use strict'

const { contextBridge } = require('electron')

const status = {
  running: true,
  remoteUrl: 'https://deepseek-harness-example.trycloudflare.com',
  tunnel: { installed: true, state: 'Connected', provider: 'Cloudflare Quick Tunnel' },
  devices: [{ id: 'phone-1', name: 'Android Phone', tailscaleLogin: '内置安全隧道', lastSeenAt: Date.now() }],
  desktop: { available: true, viewerCount: 1, locked: false },
  desktopControl: { active: true, deviceId: 'phone-1', deviceName: 'Android Phone', displayId: 'primary' }
}

contextBridge.exposeInMainWorld('dshRemote', {
  getStatus: async () => status,
  enable: async () => status,
  disable: async () => status,
  createPairing: async () => ({ pairingId: 'pair-1', verificationCode: '428 615', qrDataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="white"/><path d="M24 24h64v64H24zm128 0h64v64h-64zM24 152h64v64H24zm104-24h24v24h-24zm40 0h48v24h-48zm-40 40h24v48h-24zm40 8h48v40h-48z" fill="%2307111f"/></svg>' }),
  approvePairing: async () => ({ approved: true }),
  revokeDevice: async () => ({ revoked: true }),
  stopDesktopControl: async () => true,
  onStatus: () => {},
  onPairing: () => {}
})
