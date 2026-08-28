'use strict'

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, powerMonitor, screen, session } = require('electron')
const { appendFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { RemoteGateway } = require('./remote-gateway.cjs')
const { createElectronDesktopProvider } = require('./remote-desktop.cjs')

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:32145'

let remoteWindow = null
let remoteGateway = null
let controlIndicator = null
let upstreamUrl = null
let logPath = null
let shutdownStarted = false

function readArgument(name) {
  const prefix = `${name}=`
  const exactIndex = process.argv.indexOf(name)
  if (exactIndex >= 0 && process.argv[exactIndex + 1]) return process.argv[exactIndex + 1]
  const inline = process.argv.find((value) => value.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

function normalizeUpstream(rawValue) {
  const value = String(rawValue || '').trim()
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:') throw new Error('上游地址必须使用 http://。')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('出于安全考虑，上游地址必须指向本机回环地址。')
  }
  if (!parsed.port) throw new Error('上游地址必须包含端口号。')
  parsed.pathname = '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}

function writeLog(message) {
  if (!logPath) return
  const line = `[${new Date().toISOString()}] ${String(message)}\n`
  try {
    appendFileSync(logPath, line, 'utf8')
  } catch {
    // Logging must never interrupt the gateway.
  }
}

function cloudflaredPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'cloudflared.exe')
    : path.join(__dirname, 'vendor', 'cloudflared.exe')
}

function configureSessionSecurity() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function currentStatus() {
  return remoteGateway?.getStatus() || {
    running: false,
    remoteUrl: null,
    devices: [],
    tunnel: { installed: false, state: 'Stopped' }
  }
}

function broadcastStatus() {
  if (remoteWindow && !remoteWindow.isDestroyed()) {
    remoteWindow.webContents.send('remote:status', currentStatus())
  }
}

function showControlIndicator(state) {
  if (!state?.active) {
    controlIndicator?.hide()
    return
  }
  if (!controlIndicator || controlIndicator.isDestroyed()) {
    controlIndicator = new BrowserWindow({
      width: 330,
      height: 58,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'control-indicator-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    controlIndicator.setAlwaysOnTop(true, 'screen-saver')
    controlIndicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    controlIndicator.webContents.on('will-navigate', event => event.preventDefault())
    void controlIndicator.loadFile(path.join(__dirname, 'control-indicator.html'))
  }
  const workArea = screen.getPrimaryDisplay().workArea
  controlIndicator.setPosition(workArea.x + workArea.width - 346, workArea.y + 12, false)
  controlIndicator.showInactive()
  const sendState = () => controlIndicator && !controlIndicator.isDestroyed() && controlIndicator.webContents.send('remote:desktop-control', state)
  if (controlIndicator.webContents.isLoadingMainFrame()) controlIndicator.webContents.once('did-finish-load', sendState)
  else sendState()
}

async function enableRemote() {
  const status = await remoteGateway.start(upstreamUrl)
  broadcastStatus()
  return status
}

async function disableRemote() {
  await remoteGateway.stop(true)
  broadcastStatus()
  return currentStatus()
}

function registerIpc() {
  ipcMain.handle('remote:get-status', () => currentStatus())
  ipcMain.handle('remote:enable', () => enableRemote())
  ipcMain.handle('remote:disable', () => disableRemote())
  ipcMain.handle('remote:create-pairing', () => remoteGateway.createPairing())
  ipcMain.handle('remote:approve-pairing', (_event, pairingId) => remoteGateway.approvePairing(String(pairingId)))
  ipcMain.handle('remote:revoke-device', (_event, deviceId) => remoteGateway.revokeDevice(String(deviceId)))
  ipcMain.handle('remote:stop-desktop-control', () => remoteGateway.stopDesktopControl('local-stop', false))
}

function createRemoteWindow() {
  remoteWindow = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 700,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07111f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'remote-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  })
  remoteWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  remoteWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  remoteWindow.once('ready-to-show', () => remoteWindow?.show())
  remoteWindow.on('closed', () => { remoteWindow = null })
  return remoteWindow.loadFile(path.join(__dirname, 'remote.html'))
}

async function boot() {
  const logDirectory = path.join(app.getPath('userData'), 'logs')
  mkdirSync(logDirectory, { recursive: true })
  logPath = path.join(logDirectory, 'remote.log')

  upstreamUrl = normalizeUpstream(
    readArgument('--upstream') || process.env.DSH_UPSTREAM_URL || DEFAULT_UPSTREAM_URL
  )
  configureSessionSecurity()
  remoteGateway = new RemoteGateway({
    userDataPath: app.getPath('userData'),
    cloudflaredPath: cloudflaredPath(),
    log: writeLog,
    desktopProvider: createElectronDesktopProvider({
      desktopCapturer,
      screen,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      log: writeLog
    })
  })
  remoteGateway.on('status', broadcastStatus)
  remoteGateway.on('pairing', (pairing) => {
    if (remoteWindow && !remoteWindow.isDestroyed()) remoteWindow.webContents.send('remote:pairing', pairing)
  })
  remoteGateway.on('desktop-control', showControlIndicator)
  powerMonitor.on('lock-screen', () => remoteGateway.setDesktopLocked(true))
  powerMonitor.on('unlock-screen', () => remoteGateway.setDesktopLocked(false))
  registerIpc()
  await createRemoteWindow()
  try {
    await enableRemote()
  } catch (error) {
    writeLog(error instanceof Error ? error.stack || error.message : String(error))
    broadcastStatus()
    dialog.showErrorBox(
      'DeepSeek Harness Remote',
      `无法连接本机 Harness：${upstreamUrl}\n\n请先启动 Harness Web 服务，或使用 --upstream 指定地址。\n\n${error instanceof Error ? error.message : String(error)}`
    )
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (remoteWindow?.isMinimized()) remoteWindow.restore()
    remoteWindow?.show()
    remoteWindow?.focus()
  })
  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox('DeepSeek Harness Remote 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (shutdownStarted) return
    event.preventDefault()
    shutdownStarted = true
    Promise.resolve(remoteGateway?.stop(true)).finally(() => app.exit(0))
  })
}
