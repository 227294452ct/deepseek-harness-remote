'use strict'

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const httpProxy = require('http-proxy')
const QRCode = require('qrcode')

const API_PREFIX = '/_dsh_remote/v1'
const COOKIE_NAME = '__Host-dsh_remote'
const PAIRING_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const SESSION_TTL_MS = 60 * 60_000
const MAX_JSON_BYTES = 1024 * 1024
const TUNNEL_START_TIMEOUT_MS = 45_000
const PUBLIC_TUNNEL_IDENTITY = '内置安全隧道'
const MOBILE_COMPAT_PATH = '/_dsh_remote/compat.js'
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

  const revealRemoteControls = () => {
    const buttons = document.querySelectorAll('button[aria-label]')
    buttons.forEach(button => {
      const label = button.getAttribute('aria-label') || ''
      if (!label.startsWith('选择模型') && !label.startsWith('访问模式')) return
      button.style.setProperty('display', 'inline-flex', 'important')
      button.style.setProperty('visibility', 'visible', 'important')
      button.style.setProperty('opacity', '1', 'important')
      button.style.setProperty('min-width', '0', 'important')
      button.style.setProperty('max-width', '55vw', 'important')
      const group = button.parentElement
      if (group) {
        group.style.setProperty('display', 'flex', 'important')
        group.style.setProperty('visibility', 'visible', 'important')
        group.style.setProperty('opacity', '1', 'important')
        group.style.setProperty('min-width', '0', 'important')
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', revealRemoteControls, { once: true })
  } else revealRemoteControls()
  new MutationObserver(revealRemoteControls).observe(document.documentElement, {
    childList: true,
    subtree: true
  })
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
    this.devicesPath = path.join(this.userDataPath, 'remote-devices.json')
    this.devices = this.loadDevices()
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
      devices: this.devices.map(({ publicKey, ...device }) => device)
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

module.exports = { RemoteGateway, API_PREFIX, COOKIE_NAME }
