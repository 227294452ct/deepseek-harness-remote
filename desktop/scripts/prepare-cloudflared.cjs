'use strict'

const crypto = require('node:crypto')
const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } = require('node:fs')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')

const VERSION = '2026.8.2'
const EXPECTED_SHA256 = 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5'
const DOWNLOAD_URL = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`
const vendorDirectory = path.resolve(__dirname, '..', 'vendor')
const targetPath = path.join(vendorDirectory, 'cloudflared.exe')
const temporaryPath = path.join(vendorDirectory, 'cloudflared.exe.download')

function sha256(filePath) {
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function main() {
  mkdirSync(vendorDirectory, { recursive: true })
  if (existsSync(targetPath) && sha256(targetPath) === EXPECTED_SHA256) {
    console.log(`cloudflared ${VERSION} already verified`)
    return
  }

  const response = await fetch(DOWNLOAD_URL, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath))
  const actual = sha256(temporaryPath)
  if (actual !== EXPECTED_SHA256) {
    rmSync(temporaryPath, { force: true })
    throw new Error(`SHA-256 mismatch: expected ${EXPECTED_SHA256}, got ${actual}`)
  }
  if (existsSync(targetPath)) rmSync(targetPath, { force: true })
  renameSync(temporaryPath, targetPath)
  console.log(`cloudflared ${VERSION} downloaded and verified`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
