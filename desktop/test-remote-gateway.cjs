'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { mkdtempSync } = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { RemoteGateway, API_PREFIX } = require('./remote-gateway.cjs')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function websocketHandshake(port, cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    let received = ''
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        'Origin: https://desktop.test.ts.net:8443',
        'X-DSH-Test-Identity: owner@example.com',
        `Cookie: ${cookie}`,
        '', ''
      ].join('\r\n'))
    })
    socket.setTimeout(5_000)
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (received.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('timeout', () => reject(new Error('WebSocket handshake timed out')))
    socket.on('error', reject)
  })
}

async function main() {
  const upstream = http.createServer((request, response) => {
    if (String(request.headers.accept || '').includes('text/html')) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html><head><script>window.upstreamBooted=true</script></head><body>Harness</body></html>')
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin, cookie: request.headers.cookie || null }))
  })
  let upgradedHeaders = null
  upstream.on('upgrade', (request, socket) => {
    upgradedHeaders = request.headers
    const accept = crypto.createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  const upstreamPort = await listen(upstream)
  const temp = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-test-'))
  const gateway = new RemoteGateway({
    userDataPath: temp,
    allowTestIdentity: true,
    skipTailscaleServe: true,
    testRemoteUrl: 'https://desktop.test.ts.net:8443'
  })
  await gateway.start(`http://127.0.0.1:${upstreamPort}`)
  const base = `http://127.0.0.1:${gateway.gatewayPort}`
  const identityHeaders = { 'Content-Type': 'application/json', 'X-DSH-Test-Identity': 'owner@example.com' }
  const post = (route, body, headers = identityHeaders) => fetch(`${base}${API_PREFIX}${route}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  })

  try {
    const unauthorized = await fetch(base, { headers: { 'X-DSH-Test-Identity': 'owner@example.com' } })
    assert.equal(unauthorized.status, 401)

    const pairing = await gateway.createPairing()
    const pairingUrl = new URL(pairing.payload)
    const secret = new URLSearchParams(pairingUrl.hash.slice(1)).get('secret')
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const deviceId = crypto.randomUUID()
    const claim = await post('/pair/claim', { pairingId: pairing.pairingId, secret, deviceId, deviceName: 'Test Android', publicKey: publicKeyDer })
    assert.equal(claim.status, 202)
    assert.equal((await claim.json()).verificationCode, pairing.verificationCode)
    gateway.approvePairing(pairing.pairingId)

    const challengeResponse = await post('/session/challenge', { deviceId })
    assert.equal(challengeResponse.status, 200)
    const challenge = await challengeResponse.json()
    const signed = Buffer.from(`dsh-remote-v1|${deviceId}|${challenge.challengeId}|${challenge.nonce}`, 'utf8')
    const signature = crypto.sign('sha256', signed, privateKey).toString('base64')
    const open = await post('/session/open', { deviceId, challengeId: challenge.challengeId, signature })
    assert.equal(open.status, 200)
    const setCookie = open.headers.get('set-cookie')
    assert.match(setCookie, /__Host-dsh_remote=/)
    const cookie = setCookie.split(';', 1)[0]

    const browserHeaders = {
      Cookie: cookie,
      Origin: 'https://desktop.test.ts.net:8443',
      'X-DSH-Test-Identity': 'owner@example.com'
    }
    const compatPage = await fetch(base, { headers: { ...browserHeaders, Accept: 'text/html' } })
    assert.equal(compatPage.status, 200)
    const compatHtml = await compatPage.text()
    assert.ok(compatHtml.indexOf('/_dsh_remote/compat.js') < compatHtml.indexOf('window.upstreamBooted'))
    const compatScript = await fetch(`${base}/_dsh_remote/compat.js`, { headers: browserHeaders })
    assert.equal(compatScript.status, 200)
    const compatSource = await compatScript.text()
    assert.match(compatSource, /Object\.hasOwn/)
    assert.match(compatSource, /crypto\.randomUUID/)
    assert.match(compatSource, /structuredClone/)
    assert.match(compatSource, /defineAt/)
    assert.match(compatSource, /选择模型/)
    assert.doesNotThrow(() => new vm.Script(compatSource))

    const proxied = await fetch(base, { headers: {
      Cookie: cookie,
      Origin: 'https://desktop.test.ts.net:8443',
      'X-DSH-Test-Identity': 'owner@example.com'
    } })
    assert.equal(proxied.status, 200)
    const echoed = await proxied.json()
    assert.equal(echoed.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(echoed.origin, `http://127.0.0.1:${upstreamPort}`)
    assert.equal(echoed.cookie, null)

    const upgraded = await websocketHandshake(gateway.gatewayPort, cookie)
    assert.match(upgraded, /^HTTP\/1\.1 101 /)
    assert.equal(upgradedHeaders.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(upgradedHeaders.origin, `http://127.0.0.1:${upstreamPort}`)
    assert.equal(upgradedHeaders.cookie, undefined)

    gateway.revokeDevice(deviceId)
    const revoked = await fetch(base, { headers: { Cookie: cookie, Origin: 'https://desktop.test.ts.net:8443', 'X-DSH-Test-Identity': 'owner@example.com' } })
    assert.equal(revoked.status, 401)
    console.log('remote-gateway-auth-proxy-test-ok')
  } finally {
    await gateway.stop(false)
    await new Promise((resolve) => upstream.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
