'use strict'

const http = require('node:http')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { MOBILE_COMPAT_SCRIPT } = require('../remote-gateway.cjs')

function createMobileLayoutFixtureServer() {
  const fixture = readFileSync(path.join(__dirname, '..', 'mobile-layout-fixture.html'))
  return http.createServer((request, response) => {
    if (request.url === '/compat.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(MOBILE_COMPAT_SCRIPT)
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    response.end(fixture)
  })
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
