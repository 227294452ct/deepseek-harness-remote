'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')

const KEY_CODES = Object.freeze({
  Enter: 0x0D,
  Escape: 0x1B,
  Tab: 0x09,
  Backspace: 0x08,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Delete: 0x2E,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Control: 0x11,
  Alt: 0x12,
  Shift: 0x10
})

function helperPath(isPackaged, resourcesPath) {
  return isPackaged
    ? path.join(resourcesPath, 'windows-input-helper.ps1')
    : path.join(__dirname, 'windows-input-helper.ps1')
}

class WindowsInputHelper extends EventEmitter {
  constructor(options = {}) {
    super()
    this.path = options.path || helperPath(options.isPackaged, options.resourcesPath)
    this.log = options.log || (() => {})
    this.dryRun = options.dryRun === true
    this.child = null
    this.closing = false
    this.stdoutBuffer = ''
  }

  ensureStarted() {
    if (this.child && !this.child.killed) return
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.path]
    if (this.dryRun) args.push('-DryRun')
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    this.child = child
    this.closing = false
    this.stdoutBuffer = ''
    child.stdout.on('data', chunk => {
      this.stdoutBuffer += chunk.toString('utf8')
      const lines = this.stdoutBuffer.split(/\r?\n/)
      this.stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let value
        try { value = JSON.parse(line) } catch { this.log(`Desktop input: ${line.trim()}`); continue }
        if (value?.event === 'local-input') this.emit('local-input', { kind: value.kind === 'keyboard' ? 'keyboard' : 'mouse' })
        else if (value?.event === 'input-error') this.emit('command-error', new Error(`桌面输入注入失败（${value.type || 'unknown'}${value.action ? `/${value.action}` : ''}）。`))
        else this.log(`Desktop input: ${line.trim()}`)
      }
    })
    child.stderr.on('data', chunk => this.log(`Desktop input error: ${chunk.toString('utf8').trim()}`))
    child.once('error', error => this.emit('failure', error))
    child.once('exit', code => {
      if (this.child === child) this.child = null
      if (!this.closing) this.emit('failure', new Error(`桌面输入辅助进程异常退出（${code ?? 'unknown'}）。`))
    })
  }

  send(command) {
    this.ensureStarted()
    if (!this.child?.stdin.writable) throw new Error('桌面输入辅助进程不可用。')
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  stop() {
    const child = this.child
    if (!child) return
    this.closing = true
    try {
      if (child.stdin.writable) {
        child.stdin.write('{"type":"release-all"}\n')
        child.stdin.end('{"type":"shutdown"}\n')
      }
    } catch {}
    const timer = setTimeout(() => child.kill(), 750)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
    this.child = null
  }
}

class ElectronDesktopProvider extends EventEmitter {
  constructor(options) {
    super()
    this.desktopCapturer = options.desktopCapturer
    this.screen = options.screen
    this.log = options.log || (() => {})
    this.input = new WindowsInputHelper({
      path: options.inputHelperPath,
      isPackaged: options.isPackaged,
      resourcesPath: options.resourcesPath,
      log: this.log
    })
    this.input.on('failure', error => this.emit('input-error', error))
    this.input.on('command-error', error => this.emit('input-error', error))
    this.input.on('local-input', value => this.emit('local-input', value))
  }

  isAvailable() {
    return process.platform === 'win32' && Boolean(this.desktopCapturer && this.screen)
  }

  prepare() {
    this.input.ensureStarted()
  }

  listDisplays() {
    if (!this.isAvailable()) return []
    const primaryId = String(this.screen.getPrimaryDisplay().id)
    return this.screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      name: String(display.label || `显示器 ${index + 1}`),
      primary: String(display.id) === primaryId,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor
    })).sort((left, right) => Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name, 'zh-CN'))
  }

  resolveDisplay(displayId) {
    const all = this.screen.getAllDisplays()
    return all.find(display => String(display.id) === String(displayId)) || this.screen.getPrimaryDisplay()
  }

  async captureFrame(displayId) {
    const display = this.resolveDisplay(displayId)
    const requestedScale = 1280 / Math.max(display.bounds.width, display.bounds.height)
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.bounds.width * requestedScale)),
      height: Math.max(1, Math.round(display.bounds.height * requestedScale))
    }
    const sources = await this.desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false })
    const source = sources.find(item => String(item.display_id) === String(display.id)) || sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('暂时无法读取桌面画面。')
    const size = source.thumbnail.getSize()
    const scale = Math.min(1, 1280 / Math.max(size.width, size.height))
    const image = scale < 1
      ? source.thumbnail.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
      : source.thumbnail
    return image.toJPEG(60)
  }

  dispatchInput(displayId, message) {
    const display = this.resolveDisplay(displayId)
    if (message.type === 'pointer') {
      const dip = {
        x: display.bounds.x + Math.min(display.bounds.width - 1, Math.max(0, Math.round(message.x * display.bounds.width))),
        y: display.bounds.y + Math.min(display.bounds.height - 1, Math.max(0, Math.round(message.y * display.bounds.height)))
      }
      const physical = this.screen.dipToScreenPoint(dip)
      this.input.send({ type: 'pointer', action: message.action, button: message.button, x: physical.x, y: physical.y })
      return
    }
    if (message.type === 'wheel') {
      this.input.send({ type: 'wheel', deltaX: message.deltaX, deltaY: message.deltaY })
      return
    }
    if (message.type === 'text') {
      this.input.send({ type: 'text', text: message.text })
      return
    }
    if (message.type === 'key') {
      const keys = [...new Set([...(message.modifiers || []), message.key])]
      const codes = keys.map(key => KEY_CODES[key] || (/^[A-Z0-9]$/.test(key) ? key.charCodeAt(0) : null))
      if (codes.some(code => code === null)) throw new Error('不支持该按键。')
      this.input.send({ type: 'key', action: message.action, codes })
    }
  }

  ping() {
    if (this.input.child) this.input.send({ type: 'ping' })
  }

  releaseAll() {
    this.input.stop()
  }

  dispose() {
    this.releaseAll()
  }
}

function createElectronDesktopProvider(options) {
  return new ElectronDesktopProvider(options)
}

module.exports = { createElectronDesktopProvider, ElectronDesktopProvider, WindowsInputHelper, KEY_CODES }
