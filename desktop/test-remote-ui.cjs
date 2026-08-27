'use strict'

const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const output = process.env.DSH_REMOTE_UI_SCREENSHOT
  if (!output) throw new Error('DSH_REMOTE_UI_SCREENSHOT is required')
  const errors = []
  const window = new BrowserWindow({
    width: 940,
    height: 760,
    show: false,
    backgroundColor: '#07111f',
    webPreferences: {
      preload: path.join(__dirname, 'test-remote-ui-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message)
  })
  await window.loadFile(path.join(__dirname, 'remote.html'))
  await window.webContents.executeJavaScript("document.getElementById('pair').click()")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const layout = await window.webContents.executeJavaScript(`(() => ({
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    title: document.querySelector('h1')?.textContent,
    qrVisible: document.getElementById('qr')?.classList.contains('visible'),
    buttonRects: [...document.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0).map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent, width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    })
  }))()`)
  const buttonsValid = layout.buttonRects.every((rect) => rect.width > 40 && rect.height > 28 && rect.left >= 0 && rect.right <= 940)
  if (layout.overflowX || layout.title !== '手机远程' || !layout.qrVisible || !buttonsValid || errors.length) {
    throw new Error(`Remote UI audit failed: ${JSON.stringify({ layout, errors })}`)
  }
  const image = await window.webContents.capturePage()
  writeFileSync(output, image.toPNG())
  console.log(`remote-ui-audit-ok ${JSON.stringify(layout)}`)
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
