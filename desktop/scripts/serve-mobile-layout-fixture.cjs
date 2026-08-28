'use strict'

const http = require('node:http')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { MOBILE_COMPAT_SCRIPT } = require('../remote-gateway.cjs')
const { WebSocketServer } = require('ws')

function createMobileLayoutFixtureServer() {
  const fixture = readFileSync(path.join(__dirname, '..', 'mobile-layout-fixture.html'))
  const server = http.createServer((request, response) => {
    if (request.url === '/compat.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(MOBILE_COMPAT_SCRIPT)
      return
    }
    if (request.url === '/_dsh_remote/v1/desktop/capabilities') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ available: true, supportsControl: true, displays: [{ id: 'primary', name: '主屏', primary: true, width: 1920, height: 1080 }] }))
      return
    }
    if (request.url === '/_dsh_remote/v1/drives') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ drives: ['C:\\', 'F:\\'] }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(fixture)
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/_dsh_remote/v1/desktop/socket') { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, ws => {
      const displays = [
        { id: 'primary', name: '主屏', primary: true, width: 1920, height: 1080 },
        { id: 'secondary', name: '副屏', primary: false, width: 1280, height: 1024 }
      ]
      ws.send(JSON.stringify({ type: 'hello', selectedDisplayId: 'primary', desktopAvailable: true }))
      ws.send(JSON.stringify({ type: 'display-list', displays, selectedDisplayId: 'primary' }))
      ws.send(JSON.stringify({ type: 'control-state', active: true, canControl: true, controller: { deviceName: '布局测试手机' } }))
      ws.on('message', data => {
        let value
        try { value = JSON.parse(data.toString('utf8')) } catch { return }
        if (value.type === 'select-display') ws.send(JSON.stringify({ type: 'display-list', displays, selectedDisplayId: value.displayId }))
      })
    })
  })
  server.on('close', () => wss.close())
  return server
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server.address().port
}

module.exports = { createMobileLayoutFixtureServer, listen }

if (require.main === module) {
  const server = createMobileLayoutFixtureServer()
  listen(server, Number(process.env.PORT || 0)).then(port => {
    console.log(`mobile-layout-fixture http://127.0.0.1:${port}/`)
  }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
