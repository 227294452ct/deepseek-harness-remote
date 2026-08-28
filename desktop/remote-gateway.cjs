'use strict'

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { constants: fsConstants, existsSync, mkdirSync, promises: fsPromises, readFileSync, renameSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const httpProxy = require('http-proxy')
const QRCode = require('qrcode')
const { WebSocket, WebSocketServer } = require('ws')

const API_PREFIX = '/_dsh_remote/v1'
const COOKIE_NAME = '__Host-dsh_remote'
const PAIRING_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const SESSION_TTL_MS = 60 * 60_000
const MAX_JSON_BYTES = 1024 * 1024
const TUNNEL_START_TIMEOUT_MS = 45_000
const PUBLIC_TUNNEL_IDENTITY = '内置安全隧道'
const MOBILE_COMPAT_PATH = '/_dsh_remote/compat.js'
const DESKTOP_SOCKET_PATH = `${API_PREFIX}/desktop/socket`
const DESKTOP_MESSAGE_BYTES = 4 * 1024
const DESKTOP_FRAME_INTERVAL_MS = Math.ceil(1000 / 6)
const DESKTOP_HEARTBEAT_TIMEOUT_MS = 15_000
const DESKTOP_MAX_BUFFERED_BYTES = 1024 * 1024
const MOBILE_COMPAT_SCRIPT = `'use strict';
(() => {
  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      configurable: true,
      writable: true,
      value(object, property) {
        return Object.prototype.hasOwnProperty.call(Object(object), property)
      }
    })
  }

  if (
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID !== 'function' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      writable: true,
      value() {
        const bytes = new Uint8Array(16)
        globalThis.crypto.getRandomValues(bytes)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
        return [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20)
        ].join('-')
      }
    })
  }

  const defineAt = (prototype) => {
    if (!prototype || typeof prototype.at === 'function') return
    Object.defineProperty(prototype, 'at', {
      configurable: true,
      writable: true,
      value(index) {
        const length = Number(this.length) || 0
        let position = Number(index) || 0
        position = position < 0 ? Math.ceil(position) : Math.floor(position)
        if (position < 0) position += length
        if (position < 0 || position >= length) return undefined
        return this[position]
      }
    })
  }

  defineAt(Array.prototype)
  defineAt(String.prototype)
  ;[
    globalThis.Int8Array,
    globalThis.Uint8Array,
    globalThis.Uint8ClampedArray,
    globalThis.Int16Array,
    globalThis.Uint16Array,
    globalThis.Int32Array,
    globalThis.Uint32Array,
    globalThis.Float32Array,
    globalThis.Float64Array,
    globalThis.BigInt64Array,
    globalThis.BigUint64Array
  ].forEach(Type => {
    if (typeof Type === 'function') defineAt(Type.prototype)
  })

  if (typeof globalThis.structuredClone !== 'function') {
    const cloneValue = (value, seen) => {
      if (value === null || typeof value !== 'object') return value
      if (seen.has(value)) return seen.get(value)
      if (value instanceof Date) return new Date(value.getTime())
      if (value instanceof RegExp) return new RegExp(value.source, value.flags)
      if (value instanceof ArrayBuffer) return value.slice(0)
      if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
          return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        }
        return new value.constructor(value)
      }
      if (value instanceof Map) {
        const output = new Map()
        seen.set(value, output)
        value.forEach((item, key) => output.set(cloneValue(key, seen), cloneValue(item, seen)))
        return output
      }
      if (value instanceof Set) {
        const output = new Set()
        seen.set(value, output)
        value.forEach(item => output.add(cloneValue(item, seen)))
        return output
      }
      const output = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
      seen.set(value, output)
      Reflect.ownKeys(value).forEach(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) return
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          descriptor.value = cloneValue(descriptor.value, seen)
        }
        Object.defineProperty(output, key, descriptor)
      })
      return output
    }
    Object.defineProperty(globalThis, 'structuredClone', {
      configurable: true,
      writable: true,
      value(value) {
        return cloneValue(value, new Map())
      }
    })
  }

  const MOBILE_LAYOUT_STYLE_ID = 'dsh-remote-mobile-layout'
  const mobileLayoutCss = [
    '[data-dsh-remote-sidebar-foot], [data-dsh-remote-sidebar-settings] { box-sizing: border-box !important; flex: 0 0 auto !important; height: auto !important; min-height: 94px !important; overflow: visible !important; }',
    '[data-dsh-remote-sidebar-foot] { display: flex !important; flex-direction: column !important; justify-content: flex-end !important; }',
    '[data-dsh-remote-sidebar-settings] { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: flex-end !important; gap: 2px !important; }',
    '[data-dsh-remote-sidebar-column] { min-height: 0 !important; }',
    '[data-dsh-remote-desktop-entry-wrap] { box-sizing: border-box !important; flex: 0 0 40px !important; width: 100% !important; height: 40px !important; min-height: 40px !important; display: flex !important; align-items: center !important; justify-content: center !important; overflow: visible !important; }',
    '@media (max-width: 720px) and (orientation: portrait) {',
    '  html, body { max-width: 100vw; overflow-x: hidden; }',
    '  [data-dsh-remote-session-header] { min-width: 0 !important; padding: 8px 10px 0 !important; }',
    '  [data-dsh-remote-session-header] > div:first-child { min-width: 0 !important; gap: 6px !important; }',
    '  [data-dsh-remote-header-utilities] { min-width: 0 !important; max-width: 42vw !important; margin-left: 6px !important; gap: 4px !important; overflow-x: auto !important; overscroll-behavior-inline: contain; scrollbar-width: none; }',
    '  [data-dsh-remote-header-utilities]::-webkit-scrollbar { display: none; }',
    '  [data-dsh-remote-session-log] { min-width: 0 !important; max-width: 100% !important; min-height: 36px !important; padding-inline: 10px !important; }',
    '  [data-dsh-remote-session-header] [role="tablist"] { min-width: 0 !important; gap: 24px !important; padding-left: 4px !important; overflow-x: auto !important; scrollbar-width: none; }',
    '  [data-dsh-remote-session-header] [role="tablist"]::-webkit-scrollbar { display: none; }',
    '  [data-question-key], [data-plan-review-key] { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; padding: 6px 8px calc(10px + env(safe-area-inset-bottom)) !important; }',
    '  [data-question-key] > section, [data-plan-review-key] > section { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; border-radius: 14px !important; }',
    '  [data-question-key] > section > header { min-width: 0 !important; gap: 8px !important; padding: 12px 12px 0 14px !important; }',
    '  [data-question-key] > section > header > :first-child { min-width: 0 !important; }',
    '  [data-question-key] > section > header h2 { overflow-wrap: anywhere !important; word-break: break-word !important; }',
    '  [data-question-key] > section > [data-question-scroll] { min-width: 0 !important; }',
    '  [data-question-key] > section > [data-question-scroll] button { max-width: 100% !important; min-width: 0 !important; overflow-wrap: anywhere !important; }',
    '  [data-question-key] > section > footer { display: grid !important; grid-template-columns: auto minmax(0, 1fr) !important; align-items: center !important; gap: 8px !important; margin-top: 8px !important; padding: 8px 10px 2px !important; }',
    '  [data-question-key] > section > footer > :nth-child(2) { min-width: 0 !important; overflow-wrap: anywhere !important; }',
    '  [data-question-key] > section > footer > :last-child { grid-column: 1 / -1 !important; box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 8px !important; }',
    '  [data-question-key] > section > footer > :last-child > button { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; min-height: 42px !important; padding-inline: 10px !important; white-space: normal !important; }',
    '  [data-plan-review-key] > section > footer { align-items: stretch !important; flex-direction: column !important; gap: 8px !important; padding: 8px 12px 10px !important; }',
    '  [data-plan-review-key] > section > footer > :last-child { box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 8px !important; }',
    '  [data-plan-review-key] > section > footer > :last-child > button { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; min-height: 42px !important; white-space: normal !important; }',
    '  [data-dsh-remote-composer-stack], [data-dsh-remote-composer-root], [data-dsh-remote-composer-card], [data-dsh-remote-composer-row], [data-dsh-remote-composer-trailing] { box-sizing: border-box !important; min-width: 0 !important; max-width: 100% !important; }',
    '  [data-dsh-remote-composer-stack], [data-dsh-remote-composer-root] { width: 100% !important; }',
    '  [data-dsh-remote-composer-row], [data-dsh-remote-composer-trailing] { overflow: hidden !important; }',
    '  [data-dsh-remote-composer-trailing] { display: flex !important; align-items: center !important; }',
    '  [data-dsh-remote-composer-trailing] > * { min-width: 0 !important; max-width: 100% !important; }',
    '  [data-dsh-remote-composer-trailing] button:not([data-dsh-remote-send]) { flex-shrink: 1 !important; overflow: hidden !important; }',
    '  [data-dsh-remote-send] { display: grid !important; visibility: visible !important; opacity: 1 !important; flex: 0 0 34px !important; width: 34px !important; min-width: 34px !important; max-width: 34px !important; height: 34px !important; margin-left: 4px !important; position: relative !important; z-index: 2 !important; }',
    '}',
    '@media (max-width: 420px) and (orientation: portrait) {',
    '  [data-dsh-remote-session-log] { width: 36px !important; padding: 0 !important; justify-content: center !important; }',
    '  [data-dsh-remote-session-log] span { display: none !important; }',
    '}'
  ].join('\\n')

  const installRemoteMobileLayout = () => {
    if (document.getElementById(MOBILE_LAYOUT_STYLE_ID)) return
    const style = document.createElement('style')
    style.id = MOBILE_LAYOUT_STYLE_ID
    style.setAttribute('data-dsh-remote-mobile-layout', '')
    style.textContent = mobileLayoutCss
    ;(document.head || document.documentElement).appendChild(style)
  }

  const markRemoteMobileLayout = () => {
    if (!document.querySelector('[data-dsh-remote-session-log]')) {
      document.querySelectorAll('button').forEach(button => {
        if (!(button.textContent || '').trim().startsWith('Session log')) return
        button.setAttribute('data-dsh-remote-session-log', '')
        if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', 'Session log')
        if (!button.getAttribute('title')) button.setAttribute('title', 'Session log')
        const utilities = button.parentElement
        if (utilities) utilities.setAttribute('data-dsh-remote-header-utilities', '')
        const header = button.closest('header')
        if (header) header.setAttribute('data-dsh-remote-session-header', '')
      })
    }
    document.querySelectorAll('button[aria-label="发送消息"],button[aria-label="Send message"]').forEach(button => {
      button.setAttribute('data-dsh-remote-send', '')
      const trailing = button.parentElement
      const row = trailing && trailing.parentElement
      const card = row && row.parentElement
      const root = card && card.parentElement
      if (trailing) trailing.setAttribute('data-dsh-remote-composer-trailing', '')
      if (row) row.setAttribute('data-dsh-remote-composer-row', '')
      if (card) card.setAttribute('data-dsh-remote-composer-card', '')
      if (root) root.setAttribute('data-dsh-remote-composer-root', '')
      const slot = button.closest('[data-slot="conversation.composer.bar"]')
      if (slot && slot.parentElement) slot.parentElement.setAttribute('data-dsh-remote-composer-stack', '')
    })
  }

  const revealRemoteControls = () => {
    const buttons = document.querySelectorAll('button[aria-label^="选择模型"],button[aria-label^="访问模式"]')
    buttons.forEach(button => {
      button.style.setProperty('display', 'inline-flex', 'important')
      button.style.setProperty('visibility', 'visible', 'important')
      button.style.setProperty('opacity', '1', 'important')
      button.style.setProperty('min-width', '0', 'important')
      button.style.setProperty('max-width', '100%', 'important')
      button.style.setProperty('flex-shrink', '1', 'important')
      const group = button.parentElement
      if (group) {
        group.style.setProperty('display', 'flex', 'important')
        group.style.setProperty('visibility', 'visible', 'important')
        group.style.setProperty('opacity', '1', 'important')
        group.style.setProperty('min-width', '0', 'important')
      }
    })
  }

  const refreshRemoteCompatibility = () => {
    installRemoteMobileLayout()
    markRemoteMobileLayout()
    revealRemoteControls()
  }

  let remoteCompatibilityPending = false
  const scheduleRemoteCompatibility = () => {
    if (remoteCompatibilityPending) return
    remoteCompatibilityPending = true
    requestAnimationFrame(() => {
      remoteCompatibilityPending = false
      refreshRemoteCompatibility()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRemoteCompatibility, { once: true })
  } else scheduleRemoteCompatibility()
  new MutationObserver(scheduleRemoteCompatibility).observe(document.documentElement, {
    childList: true,
    subtree: true
  })

  const remoteStyle = document.createElement('style')
  remoteStyle.setAttribute('data-dsh-remote-desktop-style', '')
  remoteStyle.textContent = [
    '[data-dsh-remote-drive-bar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid rgba(128,128,128,.22)}',
    '[data-dsh-remote-drive-bar] strong{font-size:12px;color:#64748b;margin-right:2px}',
    '[data-dsh-remote-drive-bar] button{min-width:48px;height:34px;padding:0 10px;border:1px solid rgba(128,128,128,.28);border-radius:9px;background:transparent;color:inherit}',
    '[data-dsh-remote-desktop-entry]{display:flex!important;align-items:center;justify-content:center;gap:9px;min-width:40px;min-height:40px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit}',
    '[data-dsh-remote-desktop-entry-wrap]{flex:none;min-width:0;width:100%}',
    '[data-dsh-remote-desktop-entry] svg{width:22px;height:22px;flex:none}',
    '[data-dsh-remote-desktop-entry] span{display:none}',
    '[data-dsh-remote-desktop-entry][data-expanded="true"]{width:100%;justify-content:flex-start;padding:0 12px}',
    '[data-dsh-remote-desktop-entry][data-expanded="true"] span{display:inline}',
    '[data-dsh-remote-desktop-viewer]{position:fixed;inset:0;z-index:2147483646;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#05080d;color:#f8fafc;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);font-family:system-ui,sans-serif;touch-action:none}',
    '[data-dsh-remote-desktop-toolbar]{display:flex;align-items:center;gap:8px;min-height:54px;padding:7px 10px;background:#0d1521;border-bottom:1px solid #263243}',
    '[data-dsh-remote-desktop-toolbar] button,[data-dsh-remote-desktop-toolbar] select{height:38px;border:1px solid #344257;border-radius:10px;background:#152033;color:#f8fafc;padding:0 11px;font:600 13px inherit}',
    '[data-dsh-remote-desktop-status]{min-width:0;flex:1;font-size:12px;color:#a8bad0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '[data-dsh-remote-desktop-stage]{position:relative;min-width:0;min-height:0;display:grid;place-items:center;overflow:hidden;background:#000;touch-action:none;user-select:none}',
    '[data-dsh-remote-desktop-stage] img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}',
    '[data-dsh-remote-desktop-empty]{position:absolute;inset:0;display:grid;place-items:center;color:#94a3b8;font-size:14px;padding:30px;text-align:center;pointer-events:none}',
    '[data-dsh-remote-keyboard]{display:none;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:#0d1521;border-top:1px solid #263243}',
    '[data-dsh-remote-keyboard].open{display:grid;gap:8px}',
    '[data-dsh-remote-keyboard] textarea{width:100%;height:42px;resize:none;border:1px solid #344257;border-radius:10px;background:#101a2a;color:#fff;padding:9px 11px;font:16px system-ui}',
    '[data-dsh-remote-key-row]{display:flex;gap:6px;overflow-x:auto}',
    '[data-dsh-remote-key-row] button{flex:none;min-width:42px;height:38px;border:1px solid #344257;border-radius:9px;background:#18253a;color:#f8fafc;font:600 12px system-ui}',
    '[data-dsh-remote-key-row] button.active{background:#2563eb;border-color:#60a5fa}',
    '@media(orientation:landscape) and (max-height:500px){[data-dsh-remote-desktop-toolbar]{min-height:46px;padding:4px 8px}[data-dsh-remote-desktop-toolbar] button,[data-dsh-remote-desktop-toolbar] select{height:34px}[data-dsh-remote-keyboard]{position:absolute;left:0;right:0;bottom:0;z-index:2;background:rgba(13,21,33,.97)}}'
  ].join('')
  ;(document.head || document.documentElement).appendChild(remoteStyle)

  const setReactInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
  }

  const chooseDrive = (dialog, root) => {
    const edit = dialog.querySelector('button[aria-label="编辑路径"],button[aria-label="Edit path"]')
    if (!edit) return
    edit.click()
    let attempts = 0
    const findInput = () => {
      const input = dialog.querySelector('input')
      if (input) { input.focus(); setReactInputValue(input, root); return }
      attempts += 1
      if (attempts < 12) requestAnimationFrame(findInput)
    }
    requestAnimationFrame(findInput)
  }

  const installDriveBars = () => {
    document.querySelectorAll('[role="dialog"],dialog').forEach(dialog => {
      const title = dialog.querySelector('h1,h2,h3,[role="heading"]')
      if (!title || !/^(选择工作区目录|Select Workspace Directory)$/.test((title.textContent || '').trim())) return
      if (dialog.dataset.dshRemoteDrives) return
      dialog.dataset.dshRemoteDrives = 'loading'
      fetch('/_dsh_remote/v1/drives', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error('drive request failed')
        return response.json()
      }).then(value => {
        const drives = Array.isArray(value.drives) ? value.drives : []
        if (drives.length === 0 || !dialog.isConnected) return
        const bar = document.createElement('div')
        bar.setAttribute('data-dsh-remote-drive-bar', '')
        const label = document.createElement('strong')
        label.textContent = '磁盘'
        bar.appendChild(label)
        drives.forEach(root => {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = root
          button.addEventListener('click', () => chooseDrive(dialog, root))
          bar.appendChild(button)
        })
        const header = title.parentElement
        if (header && header.parentElement) header.insertAdjacentElement('afterend', bar)
        else title.insertAdjacentElement('afterend', bar)
        dialog.dataset.dshRemoteDrives = 'ready'
      }).catch(() => { dialog.dataset.dshRemoteDrives = 'failed' })
    })
  }

  let desktopCapability = null
  let desktopCapabilityPending = false
  let desktopViewer = null
  let desktopSocket = null
  let desktopReconnects = 0
  let desktopReconnectTimer = null
  let desktopHeartbeat = null
  let desktopObjectUrl = null
  let desktopDisplays = []
  let desktopSelectedId = ''
  let desktopCanControl = false
  const remoteMobileClient = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches)

  const desktopIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 4.8h16v11.4H4zM8.5 20h7M12 16.2V20"/></svg>'

  const updateDesktopStatus = (text) => {
    const node = desktopViewer && desktopViewer.querySelector('[data-dsh-remote-desktop-status]')
    if (node) node.textContent = text
  }

  const sendDesktop = value => {
    if (desktopSocket && desktopSocket.readyState === WebSocket.OPEN) desktopSocket.send(JSON.stringify(value))
  }

  const renderDisplaySelect = () => {
    if (!desktopViewer) return
    const select = desktopViewer.querySelector('select')
    select.replaceChildren()
    desktopDisplays.forEach(display => {
      const option = document.createElement('option')
      option.value = display.id
      option.textContent = display.name + (display.primary ? '（主屏）' : '')
      option.selected = display.id === desktopSelectedId
      select.appendChild(option)
    })
  }

  const closeDesktopSocket = () => {
    clearTimeout(desktopReconnectTimer)
    clearInterval(desktopHeartbeat)
    desktopReconnectTimer = null
    desktopHeartbeat = null
    if (desktopSocket) {
      const socket = desktopSocket
      desktopSocket = null
      try { socket.close(1000, 'viewer closed') } catch {}
    }
  }

  const teardownDesktopViewer = () => {
    closeDesktopSocket()
    if (desktopObjectUrl) URL.revokeObjectURL(desktopObjectUrl)
    desktopObjectUrl = null
    desktopViewer && desktopViewer.remove()
    desktopViewer = null
    desktopDisplays = []
    desktopCanControl = false
  }

  const requestDesktopClose = () => {
    if (history.state && history.state.dshRemoteDesktop) history.back()
    else teardownDesktopViewer()
  }

  const connectDesktopSocket = () => {
    if (!desktopViewer) return
    closeDesktopSocket()
    updateDesktopStatus(desktopReconnects ? '正在重新连接…' : '正在连接…')
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(protocol + '//' + location.host + '/_dsh_remote/v1/desktop/socket')
    desktopSocket = socket
    socket.binaryType = 'blob'
    socket.onopen = () => {
      desktopReconnects = 0
      updateDesktopStatus('已连接 · 正在等待画面')
      desktopHeartbeat = setInterval(() => sendDesktop({ type: 'heartbeat' }), 5000)
      sendDesktop({ type: 'heartbeat' })
    }
    socket.onmessage = event => {
      if (event.data instanceof Blob) {
        const image = desktopViewer && desktopViewer.querySelector('img')
        if (!image) return
        const oldUrl = desktopObjectUrl
        desktopObjectUrl = URL.createObjectURL(event.data)
        image.onload = () => { if (oldUrl) URL.revokeObjectURL(oldUrl) }
        image.src = desktopObjectUrl
        const empty = desktopViewer.querySelector('[data-dsh-remote-desktop-empty]')
        if (empty) empty.hidden = true
        return
      }
      let value
      try { value = JSON.parse(event.data) } catch { return }
      if (value.type === 'hello') desktopSelectedId = value.selectedDisplayId || desktopSelectedId
      if (value.type === 'display-list') {
        desktopDisplays = Array.isArray(value.displays) ? value.displays : []
        if (value.selectedDisplayId) desktopSelectedId = value.selectedDisplayId
        renderDisplaySelect()
      }
      if (value.type === 'control-state') {
        desktopCanControl = value.canControl === true
        updateDesktopStatus(desktopCanControl ? '已连接 · 你正在控制' : (value.active ? '已连接 · 仅查看，' + value.controller.deviceName + ' 正在控制' : '已连接 · 仅查看'))
      }
      if (value.type === 'stream-state' && value.state === 'paused') updateDesktopStatus(value.reason === 'screen-locked' ? '电脑已锁屏，画面已暂停' : '画面暂时不可用')
      if (value.type === 'error') updateDesktopStatus(value.message || '远程桌面发生错误')
    }
    socket.onclose = event => {
      if (desktopSocket === socket) desktopSocket = null
      clearInterval(desktopHeartbeat)
      if (!desktopViewer) return
      if (event.code === 1008 || event.code === 4401) { teardownDesktopViewer(); return }
      const retry = () => {
        if (!desktopViewer) return
        if (desktopReconnects >= 3) { updateDesktopStatus('连接已断开，请返回后重试'); return }
        desktopReconnects += 1
        updateDesktopStatus('连接中断，正在重试…')
        desktopReconnectTimer = setTimeout(connectDesktopSocket, [500, 1000, 2000][desktopReconnects - 1])
      }
      fetch('/_dsh_remote/v1/desktop/capabilities', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (response.status === 401 || response.status === 403) teardownDesktopViewer()
        else retry()
      }).catch(retry)
    }
    socket.onerror = () => {}
  }

  const installTouchControls = stage => {
    const active = new Map()
    let gesture = null
    let tapTimer = null
    let lastTap = null
    const point = touch => ({ x: touch.clientX, y: touch.clientY })
    const mapped = touch => {
      const display = desktopDisplays.find(item => item.id === desktopSelectedId)
      if (!display) return null
      const rect = stage.getBoundingClientRect()
      const scale = Math.min(rect.width / display.width, rect.height / display.height)
      const width = display.width * scale
      const height = display.height * scale
      const left = rect.left + (rect.width - width) / 2
      const top = rect.top + (rect.height - height) / 2
      if (touch.clientX < left || touch.clientX > left + width || touch.clientY < top || touch.clientY > top + height) return null
      return { x: (touch.clientX - left) / width, y: (touch.clientY - top) / height }
    }
    const pointer = (action, touch, button) => {
      const value = mapped(touch)
      if (value && desktopCanControl) sendDesktop({ type: 'pointer', action, button: button || 'left', x: value.x, y: value.y })
    }
    stage.addEventListener('touchstart', event => {
      event.preventDefault()
      Array.from(event.changedTouches).forEach(touch => active.set(touch.identifier, point(touch)))
      if (active.size === 1) {
        const touch = event.touches[0]
        const start = point(touch)
        gesture = { kind: 'tap', id: touch.identifier, start, last: start, down: false, longTimer: setTimeout(() => {
          if (gesture && gesture.kind === 'tap' && !gesture.down) { pointer('click', touch, 'right'); gesture.kind = 'long' }
        }, 520) }
      } else if (active.size === 2) {
        if (gesture && gesture.longTimer) clearTimeout(gesture.longTimer)
        const ys = Array.from(event.touches).map(touch => touch.clientY)
        gesture = { kind: 'scroll', lastY: (ys[0] + ys[1]) / 2 }
      }
    }, { passive: false })
    stage.addEventListener('touchmove', event => {
      event.preventDefault()
      if (!gesture) return
      if (gesture.kind === 'scroll' && event.touches.length >= 2) {
        const y = (event.touches[0].clientY + event.touches[1].clientY) / 2
        const delta = Math.max(-1200, Math.min(1200, Math.round((gesture.lastY - y) * 6)))
        if (desktopCanControl && delta) sendDesktop({ type: 'wheel', deltaX: 0, deltaY: delta })
        gesture.lastY = y
        return
      }
      const touch = Array.from(event.touches).find(item => item.identifier === gesture.id)
      if (!touch) return
      const now = point(touch)
      const distance = Math.hypot(now.x - gesture.start.x, now.y - gesture.start.y)
      if (distance > 8 && gesture.kind === 'tap') {
        clearTimeout(gesture.longTimer)
        pointer('down', { clientX: gesture.start.x, clientY: gesture.start.y }, 'left')
        gesture.kind = 'drag'; gesture.down = true
      }
      if (gesture.kind === 'drag') pointer('move', touch, 'left')
      gesture.last = now
    }, { passive: false })
    stage.addEventListener('touchend', event => {
      event.preventDefault()
      Array.from(event.changedTouches).forEach(touch => active.delete(touch.identifier))
      if (!gesture || active.size > 0) return
      clearTimeout(gesture.longTimer)
      const touch = event.changedTouches[0]
      if (gesture.kind === 'drag') pointer('up', touch, 'left')
      else if (gesture.kind === 'tap') {
        const now = point(touch)
        if (lastTap && Date.now() - lastTap.time < 300 && Math.hypot(now.x - lastTap.x, now.y - lastTap.y) < 24) {
          clearTimeout(tapTimer); lastTap = null; pointer('double-click', touch, 'left')
        } else {
          lastTap = { time: Date.now(), x: now.x, y: now.y }
          tapTimer = setTimeout(() => { if (lastTap) pointer('click', touch, 'left'); lastTap = null }, 280)
        }
      }
      gesture = null
    }, { passive: false })
    stage.addEventListener('touchcancel', event => {
      if (gesture && gesture.down && event.changedTouches[0]) pointer('up', event.changedTouches[0], 'left')
      active.clear(); gesture = null
    }, { passive: false })
  }

  const installKeyboard = viewer => {
    const panel = viewer.querySelector('[data-dsh-remote-keyboard]')
    const input = panel.querySelector('textarea')
    const modifiers = new Set()
    let composing = false
    const resetModifiers = () => {
      modifiers.clear()
      panel.querySelectorAll('[data-modifier]').forEach(button => button.classList.remove('active'))
    }
    panel.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button) return
      const modifier = button.dataset.modifier
      if (modifier) {
        if (modifiers.has(modifier)) modifiers.delete(modifier); else modifiers.add(modifier)
        button.classList.toggle('active', modifiers.has(modifier)); input.focus(); return
      }
      const key = button.dataset.key
      if (key) { sendDesktop({ type: 'key', action: 'press', key, modifiers: Array.from(modifiers) }); resetModifiers(); input.focus() }
    })
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', event => {
      composing = false
      if (event.data) sendDesktop({ type: 'text', text: event.data.slice(0, 256) })
      input.value = ''
    })
    input.addEventListener('input', () => {
      if (composing || !input.value) return
      const text = input.value.slice(0, 256)
      input.value = ''
      if (modifiers.size && text.length === 1 && /^[a-z0-9]$/i.test(text)) sendDesktop({ type: 'key', action: 'press', key: text.toUpperCase(), modifiers: Array.from(modifiers) })
      else sendDesktop({ type: 'text', text })
      resetModifiers()
    })
  }

  const openDesktopViewer = () => {
    if (desktopViewer) return
    history.pushState({ dshRemoteDesktop: true }, '', location.href)
    const viewer = document.createElement('div')
    viewer.setAttribute('data-dsh-remote-desktop-viewer', '')
    viewer.innerHTML = '<div data-dsh-remote-desktop-toolbar><button type="button" data-action="back" aria-label="返回">← 返回</button><span data-dsh-remote-desktop-status>正在连接…</span><select aria-label="选择显示器"></select><button type="button" data-action="keyboard" aria-label="键盘">⌨ 键盘</button></div><div data-dsh-remote-desktop-stage><img alt="远程桌面画面"><div data-dsh-remote-desktop-empty>正在等待桌面画面…</div></div><div data-dsh-remote-keyboard><textarea inputmode="text" enterkeyhint="done" aria-label="远程输入" placeholder="在此输入中文或英文"></textarea><div data-dsh-remote-key-row><button data-key="Enter">Enter</button><button data-key="Escape">Esc</button><button data-key="Tab">Tab</button><button data-key="Backspace">⌫</button><button data-key="ArrowLeft">←</button><button data-key="ArrowUp">↑</button><button data-key="ArrowDown">↓</button><button data-key="ArrowRight">→</button></div><div data-dsh-remote-key-row><button data-modifier="Control">Ctrl</button><button data-modifier="Alt">Alt</button><button data-modifier="Shift">Shift</button><button data-key="A">A</button><button data-key="C">C</button><button data-key="V">V</button><button data-key="X">X</button><button data-key="Z">Z</button><button data-key="Y">Y</button></div></div>'
    document.body.appendChild(viewer)
    desktopViewer = viewer
    viewer.querySelector('[data-action="back"]').addEventListener('click', requestDesktopClose)
    viewer.querySelector('[data-action="keyboard"]').addEventListener('click', () => {
      const panel = viewer.querySelector('[data-dsh-remote-keyboard]')
      panel.classList.toggle('open')
      if (panel.classList.contains('open')) panel.querySelector('textarea').focus()
    })
    viewer.querySelector('select').addEventListener('change', event => {
      desktopSelectedId = event.target.value
      sendDesktop({ type: 'select-display', displayId: desktopSelectedId })
    })
    installTouchControls(viewer.querySelector('[data-dsh-remote-desktop-stage]'))
    installKeyboard(viewer)
    desktopReconnects = 0
    connectDesktopSocket()
  }

  const installDesktopEntry = () => {
    if (!remoteMobileClient || !desktopCapability || desktopCapability.available !== true) return
    const existing = document.querySelector('[data-dsh-remote-desktop-entry]')
    const markedSettingsArea = document.querySelector('[data-dsh-remote-sidebar-settings]')
    if (existing && markedSettingsArea) {
      const markedSettings = markedSettingsArea.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
      if (markedSettings) {
        if (!markedSettings.getAttribute('aria-label')) markedSettings.setAttribute('aria-label', '设置')
        if (!markedSettings.getAttribute('title')) markedSettings.setAttribute('title', '设置')
      }
      existing.dataset.expanded = markedSettingsArea.getBoundingClientRect().width > 96 ? 'true' : 'false'
      return
    }
    const isVisible = element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
    }
    const isInSidebar = element => {
      let parent = element.parentElement
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const rect = parent.getBoundingClientRect()
        const style = getComputedStyle(parent)
        if (rect.height >= innerHeight * 0.6 && rect.left <= 16 && rect.width <= Math.min(440, innerWidth) && style.flexDirection === 'column') return true
        parent = parent.parentElement
      }
      return false
    }
    const buttons = [...document.querySelectorAll('button')].filter(isVisible)
    const labelled = buttons.filter(button => [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.textContent
    ].some(value => /^(设置|settings)$/i.test((value || '').trim())))
    const settings = labelled.find(isInSidebar) || labelled[0] || buttons
      .filter(button => button.getAttribute('aria-haspopup') === 'dialog' && button.hasAttribute('aria-expanded') && isInSidebar(button))
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0]
    if (!settings || !settings.parentElement) return
    const settingsHost = settings.parentElement
    if (!settings.getAttribute('aria-label')) settings.setAttribute('aria-label', '设置')
    if (!settings.getAttribute('title')) settings.setAttribute('title', '设置')
    const settingsArea = settingsHost.parentElement
    const footArea = settingsArea && settingsArea.parentElement
    if (settingsArea) settingsArea.setAttribute('data-dsh-remote-sidebar-settings', '')
    if (footArea) footArea.setAttribute('data-dsh-remote-sidebar-foot', '')
    let sidebarColumn = footArea
    while (sidebarColumn && sidebarColumn !== document.body && sidebarColumn !== document.documentElement) {
      const rect = sidebarColumn.getBoundingClientRect()
      const style = getComputedStyle(sidebarColumn)
      if (rect.height >= innerHeight * 0.6 && rect.left <= 16 && rect.width <= Math.min(440, innerWidth) && style.flexDirection === 'column') {
        sidebarColumn.setAttribute('data-dsh-remote-sidebar-column', '')
        break
      }
      sidebarColumn = sidebarColumn.parentElement
    }
    if (existing) {
      existing.dataset.expanded = settingsArea && settingsArea.getBoundingClientRect().width > 96 ? 'true' : 'false'
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-dsh-remote-desktop-entry', '')
    button.setAttribute('aria-label', '桌面')
    button.setAttribute('title', '桌面')
    button.innerHTML = desktopIcon + '<span>桌面</span>'
    button.dataset.expanded = settingsArea && settingsArea.getBoundingClientRect().width > 96 ? 'true' : 'false'
    button.addEventListener('click', openDesktopViewer)
    if (settingsHost.parentElement) {
      const wrapper = document.createElement('div')
      wrapper.className = settingsHost.className
      wrapper.setAttribute('data-dsh-remote-desktop-entry-wrap', '')
      wrapper.appendChild(button)
      settingsHost.parentElement.insertBefore(wrapper, settingsHost)
    } else settingsHost.insertBefore(button, settings)
  }

  const refreshRemoteDesktopFeatures = () => {
    installDriveBars()
    installDesktopEntry()
    if (remoteMobileClient && !desktopCapability && !desktopCapabilityPending) {
      desktopCapabilityPending = true
      fetch('/_dsh_remote/v1/desktop/capabilities', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error('desktop unavailable')
        return response.json()
      }).then(value => { desktopCapability = value; installDesktopEntry() }).catch(() => { desktopCapability = { available: false } }).finally(() => { desktopCapabilityPending = false })
    }
  }

  let remoteDesktopFeaturesPending = false
  const scheduleRemoteDesktopFeatures = () => {
    if (remoteDesktopFeaturesPending) return
    remoteDesktopFeaturesPending = true
    requestAnimationFrame(() => {
      remoteDesktopFeaturesPending = false
      refreshRemoteDesktopFeatures()
    })
  }

  addEventListener('popstate', () => { if (desktopViewer && !(history.state && history.state.dshRemoteDesktop)) teardownDesktopViewer() })
  addEventListener('resize', installDesktopEntry)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleRemoteDesktopFeatures, { once: true })
  else scheduleRemoteDesktopFeatures()
  new MutationObserver(scheduleRemoteDesktopFeatures).observe(document.documentElement, { childList: true, subtree: true })
})()
`

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function jsonResponse(response, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  response.end(body)
}

function javascriptResponse(response, source) {
  const body = Buffer.from(source, 'utf8')
  response.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

function parseCookies(header) {
  const result = new Map()
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=')
    if (index <= 0) continue
    result.set(item.slice(0, index).trim(), item.slice(index + 1).trim())
  }
  return result
}

function normalizeDnsName(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase()
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('请求正文过大。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch {
        reject(new Error('请求正文不是有效 JSON。'))
      }
    })
    request.once('error', reject)
  })
}

function makeDeviceId() {
  return crypto.randomUUID()
}

async function listDriveRoots(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return ['/']
  const probe = options.probe || (root => fsPromises.access(root, fsConstants.R_OK))
  const timeoutMs = Math.max(1, Math.min(1000, Number(options.timeoutMs) || 1000))
  const available = new Set()
  const probes = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    probes.push(Promise.resolve().then(() => probe(root)).then(() => available.add(root)).catch(() => {}))
  }
  let timer
  await Promise.race([
    Promise.allSettled(probes),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
  ])
  clearTimeout(timer)
  return [...available].sort((left, right) => left.localeCompare(right, 'en-US'))
}

const KEY_NAMES = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Control', 'Alt', 'Shift'
])
const MODIFIER_NAMES = new Set(['Control', 'Alt', 'Shift'])
const POINTER_ACTIONS = new Set(['move', 'down', 'up', 'click', 'double-click'])
const POINTER_BUTTONS = new Set(['left', 'right', 'middle', 'none'])

function finiteNumber(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

class RemoteGateway extends EventEmitter {
  constructor(options) {
    super()
    this.userDataPath = options.userDataPath
    this.log = options.log || (() => {})
    this.cloudflaredPath = options.cloudflaredPath || path.join(__dirname, 'vendor', 'cloudflared.exe')
    this.allowTestIdentity = options.allowTestIdentity === true
    this.skipTunnel = options.skipTunnel === true || options.skipTailscaleServe === true
    this.allowPublicTunnel = options.allowPublicTunnel !== false && !this.skipTunnel
    this.testRemoteUrl = options.testRemoteUrl || null
    this.tunnelProcess = null
    this.tunnelState = 'Stopped'
    this.tunnelError = ''
    this.server = null
    this.proxy = null
    this.gatewayPort = null
    this.remoteUrl = null
    this.harnessUrl = null
    this.pairings = new Map()
    this.challenges = new Map()
    this.sessions = new Map()
    this.deviceSockets = new Map()
    this.desktopProvider = options.desktopProvider || null
    this.desktopWss = null
    this.desktopClients = new Set()
    this.desktopController = null
    this.desktopCaptureTimer = null
    this.desktopCaptureBusy = false
    this.desktopLocked = false
    this.devicesPath = path.join(this.userDataPath, 'remote-devices.json')
    this.devices = this.loadDevices()
    this.desktopProvider?.on?.('input-error', error => {
      this.log(`Desktop input helper failed: ${error.stack || error.message}`)
      this.stopDesktopControl('input-helper-failed')
    })
  }

  loadDevices() {
    try {
      const parsed = JSON.parse(readFileSync(this.devicesPath, 'utf8'))
      if (!Array.isArray(parsed.devices)) return []
      return parsed.devices.filter((device) => device && typeof device.id === 'string' && typeof device.publicKey === 'string')
    } catch {
      return []
    }
  }

  saveDevices() {
    mkdirSync(path.dirname(this.devicesPath), { recursive: true })
    const tempPath = `${this.devicesPath}.tmp`
    writeFileSync(tempPath, JSON.stringify({ version: 1, devices: this.devices }, null, 2), 'utf8')
    renameSync(tempPath, this.devicesPath)
  }

  getStatus() {
    const controller = this.desktopController
    return {
      running: this.server !== null && this.remoteUrl !== null,
      gatewayPort: this.gatewayPort,
      remoteUrl: this.remoteUrl,
      tunnel: {
        provider: this.skipTunnel ? 'Test' : 'Cloudflare Quick Tunnel',
        installed: this.skipTunnel || existsSync(this.cloudflaredPath),
        state: this.tunnelState,
        error: this.tunnelError
      },
      devices: this.devices.map(({ publicKey, ...device }) => device),
      desktop: {
        available: this.desktopProvider?.isAvailable?.() === true,
        viewerCount: this.desktopClients.size,
        locked: this.desktopLocked
      },
      desktopControl: controller ? {
        active: true,
        deviceId: controller.auth.device.id,
        deviceName: controller.auth.device.name,
        displayId: controller.selectedDisplayId
      } : { active: false }
    }
  }

  async start(harnessUrl) {
    if (this.server !== null) return this.getStatus()
    this.harnessUrl = harnessUrl
    this.proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, secure: true })
    this.proxy.on('error', (error, _request, responseOrSocket) => {
      this.log(`Remote proxy error: ${error.stack || error.message}`)
      if (responseOrSocket && typeof responseOrSocket.writeHead === 'function' && !responseOrSocket.headersSent) {
        jsonResponse(responseOrSocket, 502, { error: 'Harness 暂时不可用。' })
      } else if (responseOrSocket && typeof responseOrSocket.destroy === 'function') {
        responseOrSocket.destroy()
      }
    })

    this.server = http.createServer((request, response) => void this.handleRequest(request, response))
    this.desktopWss = new WebSocketServer({ noServer: true, maxPayload: DESKTOP_MESSAGE_BYTES, perMessageDeflate: false })
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.gatewayPort = this.server.address().port

    try {
      if (this.skipTunnel) {
        this.remoteUrl = this.testRemoteUrl || 'https://desktop.test.ts.net:8443'
        this.tunnelState = 'Connected'
      } else {
        this.remoteUrl = await this.startPublicTunnel()
      }
    } catch (error) {
      this.tunnelError = error instanceof Error ? error.message : String(error)
      await this.stop(false)
      throw error
    }
    this.log(`Remote gateway ready at ${this.remoteUrl} -> http://127.0.0.1:${this.gatewayPort}`)
    this.emit('status', this.getStatus())
    return this.getStatus()
  }

  startPublicTunnel() {
    if (!existsSync(this.cloudflaredPath)) throw new Error('桌面端缺少内置安全隧道组件。')
    this.tunnelState = 'Connecting'
    this.tunnelError = ''
    const origin = `http://127.0.0.1:${this.gatewayPort}`
    return new Promise((resolve, reject) => {
      let settled = false
      let output = ''
      const child = spawn(this.cloudflaredPath, [
        'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      this.tunnelProcess = child
      const finish = (error, url) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(url)
      }
      const consume = (chunk) => {
        const text = chunk.toString('utf8')
        this.log(`Tunnel: ${text.trim()}`)
        output = `${output}${text}`.slice(-65_536)
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
        if (match) {
          this.tunnelState = 'Connected'
          finish(null, match[0].toLowerCase())
        }
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('error', (error) => {
        this.tunnelState = 'Failed'
        this.tunnelError = error.message
        finish(error)
      })
      child.once('exit', (code) => {
        if (this.tunnelProcess === child) this.tunnelProcess = null
        if (!settled) {
          const error = new Error(`安全隧道启动失败（退出代码 ${code ?? 'unknown'}）。`)
          this.tunnelState = 'Failed'
          this.tunnelError = error.message
          finish(error)
          return
        }
        if (this.server !== null) {
          this.remoteUrl = null
          this.tunnelState = 'Disconnected'
          this.tunnelError = `安全隧道已断开（退出代码 ${code ?? 'unknown'}）。`
          this.emit('status', this.getStatus())
        }
      })
      const timer = setTimeout(() => {
        const error = new Error('安全隧道连接超时，请检查电脑网络后重试。')
        this.tunnelState = 'Failed'
        this.tunnelError = error.message
        child.kill()
        finish(error)
      }, TUNNEL_START_TIMEOUT_MS)
    })
  }

  async stop(disableServe = true) {
    if (!this.stopDesktopControl('gateway-stopped')) {
      try { this.desktopProvider?.releaseAll?.() } catch (error) { this.log(`Desktop input release failed: ${error.message}`) }
    }
    this.stopDesktopCapture()
    for (const client of this.desktopClients) client.ws.close(1001, 'gateway stopped')
    this.desktopClients.clear()
    this.desktopWss?.close()
    this.desktopWss = null
    for (const sockets of this.deviceSockets.values()) {
      for (const socket of sockets) socket.destroy()
    }
    this.deviceSockets.clear()
    this.sessions.clear()
    this.challenges.clear()
    this.pairings.clear()
    if (this.server !== null) {
      const server = this.server
      this.server = null
      await new Promise((resolve) => server.closeAllConnections ? (server.closeAllConnections(), server.close(resolve)) : server.close(resolve))
    }
    this.proxy?.close()
    this.proxy = null
    this.gatewayPort = null
    if (this.tunnelProcess !== null) {
      const child = this.tunnelProcess
      this.tunnelProcess = null
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
      } else child.kill('SIGTERM')
    }
    this.remoteUrl = null
    this.tunnelState = 'Stopped'
    if (disableServe) this.tunnelError = ''
    this.emit('status', this.getStatus())
  }

  desktopDisplays() {
    try {
      const displays = this.desktopProvider?.listDisplays?.() || []
      return displays.filter(display => display && typeof display.id === 'string' && display.id.length > 0)
    } catch (error) {
      this.log(`Desktop display enumeration failed: ${error.stack || error.message}`)
      return []
    }
  }

  sendDesktopJson(client, value) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(value))
  }

  broadcastDesktopJson(value) {
    for (const client of this.desktopClients) this.sendDesktopJson(client, value)
  }

  desktopControlView(client) {
    const controller = this.desktopController
    return {
      type: 'control-state',
      active: Boolean(controller),
      controller: controller ? { deviceId: controller.auth.device.id, deviceName: controller.auth.device.name } : null,
      canControl: controller === client,
      reason: client?.controlReason || ''
    }
  }

  broadcastDesktopControl() {
    for (const client of this.desktopClients) this.sendDesktopJson(client, this.desktopControlView(client))
    this.emit('desktop-control', this.getStatus().desktopControl)
    this.emit('status', this.getStatus())
  }

  acquireDesktopControl(client) {
    if (this.desktopController || this.desktopLocked || !this.desktopClients.has(client)) return false
    this.desktopController = client
    client.controlReason = ''
    this.broadcastDesktopControl()
    return true
  }

  stopDesktopControl(reason = 'local-stop', reassign = false) {
    const controller = this.desktopController
    if (!controller) return false
    this.desktopController = null
    controller.controlReason = reason
    try { this.desktopProvider?.releaseAll?.() } catch (error) { this.log(`Desktop input release failed: ${error.message}`) }
    if (reassign && !this.desktopLocked) {
      const next = [...this.desktopClients].find(client => client !== controller && client.ws.readyState === WebSocket.OPEN)
      if (next) this.desktopController = next
    }
    this.broadcastDesktopControl()
    return true
  }

  setDesktopLocked(locked) {
    const next = locked === true
    if (next === this.desktopLocked) return
    this.desktopLocked = next
    if (next) this.stopDesktopControl('screen-locked', false)
    else this.startDesktopCapture()
    this.broadcastDesktopJson({ type: 'stream-state', state: next ? 'paused' : 'streaming', reason: next ? 'screen-locked' : '' })
    this.emit('status', this.getStatus())
  }

  registerDesktopClient(ws, auth) {
    const displays = this.desktopDisplays()
    const selected = displays.find(display => display.primary) || displays[0] || null
    const client = { ws, auth, selectedDisplayId: selected?.id || '', lastHeartbeat: Date.now(), controlReason: '', rateWindow: Date.now(), rateCount: 0 }
    this.desktopClients.add(client)
    let sockets = this.deviceSockets.get(auth.device.id)
    if (!sockets) this.deviceSockets.set(auth.device.id, sockets = new Set())
    if (ws._socket) sockets.add(ws._socket)

    this.sendDesktopJson(client, {
      type: 'hello',
      version: 1,
      maxFrameEdge: 1280,
      maxFps: 6,
      selectedDisplayId: client.selectedDisplayId,
      desktopAvailable: this.desktopProvider?.isAvailable?.() === true,
      locked: this.desktopLocked
    })
    this.sendDesktopJson(client, { type: 'display-list', displays, selectedDisplayId: client.selectedDisplayId })
    if (!this.desktopController) this.acquireDesktopControl(client)
    else this.sendDesktopJson(client, this.desktopControlView(client))
    this.startDesktopCapture()
    this.emit('status', this.getStatus())

    ws.on('message', (data, isBinary) => this.handleDesktopMessage(client, data, isBinary))
    ws.on('close', () => {
      this.desktopClients.delete(client)
      if (ws._socket) sockets.delete(ws._socket)
      if (sockets.size === 0) this.deviceSockets.delete(auth.device.id)
      if (this.desktopController === client) this.stopDesktopControl('controller-disconnected', true)
      if (this.desktopClients.size === 0) this.stopDesktopCapture()
      this.emit('status', this.getStatus())
    })
    ws.on('error', error => this.log(`Desktop WebSocket error: ${error.message}`))
  }

  handleDesktopMessage(client, data, isBinary) {
    const now = Date.now()
    if (now - client.rateWindow >= 1000) { client.rateWindow = now; client.rateCount = 0 }
    client.rateCount += 1
    if (client.rateCount > 240) {
      client.ws.close(1008, 'rate limit')
      return
    }
    if (isBinary || data.length > DESKTOP_MESSAGE_BYTES) {
      client.ws.close(1008, 'invalid message')
      return
    }
    let message
    try { message = JSON.parse(data.toString('utf8')) } catch {
      client.ws.close(1008, 'invalid json')
      return
    }
    if (!message || typeof message.type !== 'string') {
      client.ws.close(1008, 'invalid message')
      return
    }
    if (message.type === 'heartbeat') {
      client.lastHeartbeat = now
      if (this.desktopController === client) this.desktopProvider?.ping?.()
      return
    }
    if (message.type === 'select-display') {
      const displays = this.desktopDisplays()
      const selected = displays.find(display => display.id === String(message.displayId || ''))
      if (!selected) {
        this.sendDesktopJson(client, { type: 'error', code: 'display-not-found', message: '显示器已不可用。' })
        return
      }
      client.selectedDisplayId = selected.id
      this.sendDesktopJson(client, { type: 'display-list', displays, selectedDisplayId: selected.id })
      if (this.desktopController === client) this.emit('status', this.getStatus())
      return
    }
    if (this.desktopController !== client || this.desktopLocked) return
    let valid = false
    if (message.type === 'pointer') {
      valid = POINTER_ACTIONS.has(message.action) && POINTER_BUTTONS.has(message.button) && finiteNumber(message.x, 0, 1) && finiteNumber(message.y, 0, 1)
    } else if (message.type === 'wheel') {
      valid = finiteNumber(message.deltaX, -1200, 1200) && finiteNumber(message.deltaY, -1200, 1200)
    } else if (message.type === 'text') {
      valid = typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message.text)
    } else if (message.type === 'key') {
      const modifiers = Array.isArray(message.modifiers) ? message.modifiers : []
      valid = ['press', 'down', 'up'].includes(message.action) &&
        (KEY_NAMES.has(message.key) || /^[A-Z0-9]$/.test(message.key)) &&
        modifiers.length <= 3 && modifiers.every(value => MODIFIER_NAMES.has(value))
      if (message.key === 'Delete' && modifiers.includes('Control') && modifiers.includes('Alt')) valid = false
    }
    if (!valid) {
      client.ws.close(1008, 'invalid input')
      return
    }
    try { this.desktopProvider.dispatchInput(client.selectedDisplayId, message) } catch (error) {
      this.log(`Desktop input failed: ${error.stack || error.message}`)
      this.sendDesktopJson(client, { type: 'error', code: 'input-failed', message: '桌面输入暂时不可用。' })
      this.stopDesktopControl('input-failed', false)
    }
  }

  startDesktopCapture() {
    if (this.desktopCaptureTimer || this.desktopLocked || this.desktopClients.size === 0) return
    this.desktopCaptureTimer = setInterval(() => void this.captureDesktopTick(), DESKTOP_FRAME_INTERVAL_MS)
    this.desktopCaptureTimer.unref?.()
    void this.captureDesktopTick()
  }

  stopDesktopCapture() {
    if (this.desktopCaptureTimer) clearInterval(this.desktopCaptureTimer)
    this.desktopCaptureTimer = null
  }

  async captureDesktopTick() {
    if (this.desktopCaptureBusy || this.desktopLocked || this.desktopClients.size === 0) return
    this.desktopCaptureBusy = true
    try {
      const displays = this.desktopDisplays()
      const primary = displays.find(display => display.primary) || displays[0]
      const availableIds = new Set(displays.map(display => display.id))
      for (const client of [...this.desktopClients]) {
        if (Date.now() - client.lastHeartbeat > DESKTOP_HEARTBEAT_TIMEOUT_MS) {
          client.ws.close(1001, 'heartbeat timeout')
          continue
        }
        if (!availableIds.has(client.selectedDisplayId) && primary) {
          client.selectedDisplayId = primary.id
          this.sendDesktopJson(client, { type: 'display-list', displays, selectedDisplayId: primary.id })
        }
      }
      for (const displayId of new Set([...this.desktopClients].map(client => client.selectedDisplayId).filter(Boolean))) {
        const viewers = [...this.desktopClients].filter(client => client.selectedDisplayId === displayId && client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount <= DESKTOP_MAX_BUFFERED_BYTES)
        if (viewers.length === 0) continue
        const frame = await this.desktopProvider.captureFrame(displayId)
        if (!Buffer.isBuffer(frame) || frame.length === 0) continue
        for (const client of viewers) {
          if (client.ws.bufferedAmount <= DESKTOP_MAX_BUFFERED_BYTES) client.ws.send(frame, { binary: true })
        }
      }
    } catch (error) {
      this.log(`Desktop capture failed: ${error.stack || error.message}`)
      this.broadcastDesktopJson({ type: 'stream-state', state: 'paused', reason: 'capture-failed' })
    } finally {
      this.desktopCaptureBusy = false
    }
  }

  async createPairing() {
    if (this.server === null || this.remoteUrl === null) throw new Error('请先启用手机远程访问。')
    const pairingId = crypto.randomUUID()
    const secret = base64url(crypto.randomBytes(32))
    const verificationCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairings.set(pairingId, { pairingId, secret, verificationCode, expiresAt, status: 'waiting', claim: null })
    const payload = `dshremote://pair?host=${encodeURIComponent(this.remoteUrl)}&pairingId=${encodeURIComponent(pairingId)}#secret=${encodeURIComponent(secret)}`
    const qrDataUrl = await QRCode.toDataURL(payload, { width: 420, margin: 2, errorCorrectionLevel: 'M' })
    return { pairingId, verificationCode, expiresAt, qrDataUrl, payload }
  }

  approvePairing(pairingId) {
    const pairing = this.pairings.get(pairingId)
    if (!pairing || pairing.expiresAt < Date.now() || pairing.status !== 'pending' || !pairing.claim) {
      throw new Error('配对请求不存在、已过期或尚未由手机提交。')
    }
    const claim = pairing.claim
    const now = new Date().toISOString()
    const existingIndex = this.devices.findIndex((device) => device.id === claim.deviceId)
    const device = {
      id: claim.deviceId,
      name: claim.deviceName,
      publicKey: claim.publicKey,
      tailscaleLogin: claim.tailscaleLogin,
      createdAt: existingIndex >= 0 ? this.devices[existingIndex].createdAt : now,
      lastSeenAt: now,
      revokedAt: null
    }
    if (existingIndex >= 0) this.devices.splice(existingIndex, 1, device)
    else this.devices.push(device)
    pairing.status = 'approved'
    pairing.approvedAt = Date.now()
    this.saveDevices()
    this.emit('pairing', this.getPairingView(pairing))
    this.emit('status', this.getStatus())
    return { device: { ...device, publicKey: undefined } }
  }

  revokeDevice(deviceId) {
    const device = this.devices.find((item) => item.id === deviceId)
    if (!device) throw new Error('找不到该设备。')
    device.revokedAt = new Date().toISOString()
    for (const [token, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(token)
    }
    const sockets = this.deviceSockets.get(deviceId)
    if (sockets) for (const socket of sockets) socket.destroy()
    this.deviceSockets.delete(deviceId)
    this.saveDevices()
    this.emit('status', this.getStatus())
  }

  getPairingView(pairing) {
    return {
      pairingId: pairing.pairingId,
      verificationCode: pairing.verificationCode,
      expiresAt: pairing.expiresAt,
      status: pairing.status,
      deviceName: pairing.claim?.deviceName || '',
      tailscaleLogin: pairing.claim?.tailscaleLogin || ''
    }
  }

  getIdentity(request) {
    if (this.allowPublicTunnel) return PUBLIC_TUNNEL_IDENTITY
    const login = String(request.headers['tailscale-user-login'] || '').trim().toLowerCase()
    if (login.length > 0) return login
    if (this.allowTestIdentity) return String(request.headers['x-dsh-test-identity'] || '').trim().toLowerCase()
    return ''
  }

  validateOrigin(request, allowMissing = false) {
    const origin = String(request.headers.origin || '')
    if (origin.length === 0) return allowMissing
    return this.remoteUrl !== null && origin === this.remoteUrl
  }

  cleanupExpired() {
    const now = Date.now()
    for (const [id, pairing] of this.pairings) if (pairing.expiresAt < now || (pairing.approvedAt && pairing.approvedAt + 60_000 < now)) this.pairings.delete(id)
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt < now || challenge.used) this.challenges.delete(id)
    for (const [token, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(token)
  }

  findSession(request) {
    this.cleanupExpired()
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME)
    if (!token) return null
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const session = this.sessions.get(tokenHash)
    if (!session || session.expiresAt < Date.now()) return null
    const device = this.devices.find((item) => item.id === session.deviceId && item.revokedAt === null)
    if (!device) return null
    const identity = this.getIdentity(request)
    if (identity.length === 0 || identity !== device.tailscaleLogin) return null
    return { tokenHash, session, device }
  }

  async handleRequest(request, response) {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (url.pathname === `${API_PREFIX}/health` && request.method === 'GET') {
        jsonResponse(response, 200, { ok: true, version: 1, remoteUrl: this.remoteUrl })
        return
      }
      if (url.pathname.startsWith(`${API_PREFIX}/`)) {
        await this.handleControlRequest(request, response, url)
        return
      }
      const auth = this.findSession(request)
      if (!auth) {
        jsonResponse(response, 401, { error: '此设备尚未通过手机远程认证。' })
        return
      }
      if (!this.validateOrigin(request, true)) {
        jsonResponse(response, 403, { error: '请求来源不受信任。' })
        return
      }
      if (url.pathname === MOBILE_COMPAT_PATH && request.method === 'GET') {
        javascriptResponse(response, MOBILE_COMPAT_SCRIPT)
        return
      }
      if (request.method === 'GET' && String(request.headers.accept || '').toLowerCase().includes('text/html')) {
        await this.proxyHtmlWithCompatibility(request, response)
        return
      }
      this.prepareProxyRequest(request)
      this.proxy.web(request, response, { target: this.harnessUrl })
    } catch (error) {
      this.log(`Remote request failed: ${error.stack || error.message}`)
      if (!response.headersSent) jsonResponse(response, 400, { error: error.message || '远程请求失败。' })
    }
  }

  async handleControlRequest(request, response, url) {
    const identity = this.getIdentity(request)
    if (identity.length === 0) {
      jsonResponse(response, 403, { error: '缺少可信连接身份。' })
      return
    }
    if (request.method === 'GET' && (url.pathname === `${API_PREFIX}/drives` || url.pathname === `${API_PREFIX}/desktop/capabilities`)) {
      const auth = this.findSession(request)
      if (!auth) {
        jsonResponse(response, 401, { error: '此设备尚未通过手机远程认证。' })
        return
      }
      if (!this.validateOrigin(request, true)) {
        jsonResponse(response, 403, { error: '请求来源不受信任。' })
        return
      }
      if (url.pathname === `${API_PREFIX}/drives`) {
        jsonResponse(response, 200, { drives: await listDriveRoots() })
      } else {
        const displays = this.desktopDisplays()
        jsonResponse(response, 200, {
          available: this.desktopProvider?.isAvailable?.() === true,
          locked: this.desktopLocked,
          supportsControl: this.desktopProvider?.isAvailable?.() === true,
          maxFrameEdge: 1280,
          maxFps: 6,
          displays
        })
      }
      return
    }
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: '仅支持 POST。' }, { Allow: 'POST' })
      return
    }
    const body = await readJsonBody(request)
    if (url.pathname === `${API_PREFIX}/pair/claim`) {
      this.handlePairClaim(identity, body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/pair/status`) {
      this.handlePairStatus(body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/session/challenge`) {
      this.handleSessionChallenge(identity, body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/session/open`) {
      this.handleSessionOpen(identity, body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/session/close`) {
      const auth = this.findSession(request)
      if (auth) this.sessions.delete(auth.tokenHash)
      jsonResponse(response, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
      })
      return
    }
    jsonResponse(response, 404, { error: '未知远程接口。' })
  }

  handlePairClaim(identity, body, response) {
    this.cleanupExpired()
    const pairing = this.pairings.get(String(body.pairingId || ''))
    if (!pairing || pairing.expiresAt < Date.now() || pairing.status !== 'waiting') {
      jsonResponse(response, 410, { error: '配对码无效或已过期。' })
      return
    }
    if (!timingSafeEqualText(pairing.secret, String(body.secret || ''))) {
      jsonResponse(response, 403, { error: '配对密钥不正确。' })
      return
    }
    const deviceId = String(body.deviceId || '')
    const deviceName = String(body.deviceName || '').trim().slice(0, 80)
    const publicKey = String(body.publicKey || '')
    if (!/^[0-9a-f-]{36}$/i.test(deviceId) || deviceName.length < 1 || publicKey.length < 80 || publicKey.length > 4096) {
      jsonResponse(response, 400, { error: '设备信息无效。' })
      return
    }
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
      if (key.asymmetricKeyType !== 'ec') throw new Error('wrong key type')
    } catch {
      jsonResponse(response, 400, { error: '设备公钥无效。' })
      return
    }
    pairing.claim = { deviceId, deviceName, publicKey, tailscaleLogin: identity }
    pairing.status = 'pending'
    this.emit('pairing', this.getPairingView(pairing))
    jsonResponse(response, 202, { status: 'pending', verificationCode: pairing.verificationCode, expiresAt: pairing.expiresAt })
  }

  handlePairStatus(body, response) {
    this.cleanupExpired()
    const pairing = this.pairings.get(String(body.pairingId || ''))
    if (!pairing || !timingSafeEqualText(pairing.secret, String(body.secret || ''))) {
      jsonResponse(response, 410, { error: '配对请求无效或已过期。' })
      return
    }
    jsonResponse(response, 200, {
      status: pairing.status,
      verificationCode: pairing.verificationCode,
      expiresAt: pairing.expiresAt,
      deviceId: pairing.status === 'approved' ? pairing.claim.deviceId : undefined
    })
  }

  handleSessionChallenge(identity, body, response) {
    const device = this.devices.find((item) => item.id === String(body.deviceId || '') && item.revokedAt === null)
    if (!device || device.tailscaleLogin !== identity) {
      jsonResponse(response, 403, { error: '设备未获授权。' })
      return
    }
    const challengeId = crypto.randomUUID()
    const nonce = base64url(crypto.randomBytes(32))
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    this.challenges.set(challengeId, { challengeId, nonce, deviceId: device.id, identity, expiresAt, used: false })
    jsonResponse(response, 200, { challengeId, nonce, expiresAt })
  }

  handleSessionOpen(identity, body, response) {
    this.cleanupExpired()
    const challenge = this.challenges.get(String(body.challengeId || ''))
    const device = this.devices.find((item) => item.id === String(body.deviceId || '') && item.revokedAt === null)
    if (!challenge || challenge.used || challenge.expiresAt < Date.now() || !device || challenge.deviceId !== device.id || identity !== device.tailscaleLogin) {
      jsonResponse(response, 403, { error: '认证挑战无效。' })
      return
    }
    const payload = Buffer.from(`dsh-remote-v1|${device.id}|${challenge.challengeId}|${challenge.nonce}`, 'utf8')
    let verified = false
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' })
      verified = crypto.verify('sha256', payload, key, Buffer.from(String(body.signature || ''), 'base64'))
    } catch {
      verified = false
    }
    challenge.used = true
    if (!verified) {
      jsonResponse(response, 403, { error: '设备签名无效。' })
      return
    }
    const token = base64url(crypto.randomBytes(32))
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.sessions.set(tokenHash, { deviceId: device.id, identity, expiresAt })
    device.lastSeenAt = new Date().toISOString()
    this.saveDevices()
    jsonResponse(response, 200, { ok: true, expiresAt, remoteUrl: this.remoteUrl }, {
      'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    })
  }

  prepareProxyRequest(request) {
    const target = new URL(this.harnessUrl)
    delete request.headers.cookie
    delete request.headers['tailscale-user-login']
    delete request.headers['tailscale-user-name']
    delete request.headers['tailscale-user-profile-pic']
    request.headers.host = target.host
    if (request.headers.origin) request.headers.origin = target.origin
    if (request.headers.referer) request.headers.referer = `${target.origin}/`
  }

  async proxyHtmlWithCompatibility(request, response) {
    const target = new URL(request.url || '/', this.harnessUrl)
    const headers = { ...request.headers }
    delete headers.host
    delete headers.cookie
    delete headers.connection
    delete headers.upgrade
    delete headers['content-length']
    headers['accept-encoding'] = 'identity'
    if (headers.origin) headers.origin = target.origin
    if (headers.referer) headers.referer = `${target.origin}/`

    const upstream = await fetch(target, { method: 'GET', headers, redirect: 'manual' })
    const body = Buffer.from(await upstream.arrayBuffer())
    const contentType = String(upstream.headers.get('content-type') || '')
    let output = body
    if (contentType.toLowerCase().includes('text/html')) {
      const html = body.toString('utf8')
      const tag = `<script src="${MOBILE_COMPAT_PATH}"></script>`
      const patched = /<head(?:\s[^>]*)?>/i.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${tag}`)
        : `${tag}${html}`
      output = Buffer.from(patched, 'utf8')
    }

    const outputHeaders = {}
    for (const [name, value] of upstream.headers) {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
        outputHeaders[name] = value
      }
    }
    outputHeaders['content-length'] = String(output.length)
    response.writeHead(upstream.status, outputHeaders)
    response.end(output)
  }

  handleUpgrade(request, socket, head) {
    const auth = this.findSession(request)
    if (!auth || !this.validateOrigin(request, false) || this.proxy === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === DESKTOP_SOCKET_PATH) {
      if (!this.desktopWss || this.desktopProvider?.isAvailable?.() !== true) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.desktopWss.handleUpgrade(request, socket, head, ws => this.registerDesktopClient(ws, auth))
      return
    }
    this.prepareProxyRequest(request)
    let sockets = this.deviceSockets.get(auth.device.id)
    if (!sockets) this.deviceSockets.set(auth.device.id, sockets = new Set())
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0) this.deviceSockets.delete(auth.device.id)
    })
    this.proxy.ws(request, socket, head, { target: this.harnessUrl })
  }
}

module.exports = { RemoteGateway, API_PREFIX, COOKIE_NAME, MOBILE_COMPAT_SCRIPT, listDriveRoots }
