'use strict'

const http = require('node:http')
const path = require('node:path')
const { createReadStream, statSync } = require('node:fs')

const port = Number.parseInt(process.argv[2] || '8765', 10)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port')
const host = process.argv[3] || '127.0.0.1'
if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Invalid bind address')

const apkPath = path.join(__dirname, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const apkName = 'DeepSeek-Harness-Remote-0.2.2-debug.apk'
const apkSize = statSync(apkPath).size

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/') {
    const body = Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH APK 下载</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:12vh auto;padding:24px;line-height:1.7}a{display:inline-block;padding:12px 18px;border-radius:10px;background:#176ae7;color:#fff;text-decoration:none;font-weight:700}</style><h1>DeepSeek Harness Remote</h1><p>Android 0.2.2 Debug 构建，大小 ${(apkSize / 1024 / 1024).toFixed(2)} MB。</p><a href="/${apkName}">下载 APK</a>`, 'utf8')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(body)
    return
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === `/${apkName}` || url.pathname === '/app-debug.apk')) {
    response.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': apkSize,
      'Content-Disposition': `attachment; filename="${apkName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(apkPath).pipe(response)
    return
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Not found')
})

server.listen(port, host, () => {
  console.log(`DSH APK server listening on ${host}:${port}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
