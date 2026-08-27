'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const { app, BrowserWindow } = require('electron')
const { createMobileLayoutFixtureServer, listen } = require('./scripts/serve-mobile-layout-fixture.cjs')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const server = createMobileLayoutFixtureServer()
  const port = await listen(server)
  const window = new BrowserWindow({
    width: 393,
    height: 852,
    useContentSize: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  try {
    await window.loadURL(`http://127.0.0.1:${port}/`)
    const audit = await window.webContents.executeJavaScript(`(() => {
      const visibleButtons = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0)
      const buttonRects = visibleButtons.map(button => {
        const rect = button.getBoundingClientRect()
        return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      const card = document.querySelector('[data-question-key] > section').getBoundingClientRect()
      const actions = document.querySelector('[data-question-key] > section > footer > :last-child').getBoundingClientRect()
      const actionButtons = [...document.querySelectorAll('[data-question-key] > section > footer > :last-child > button')].map(button => {
        const rect = button.getBoundingClientRect()
        return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        hasLayoutStyle: Boolean(document.querySelector('[data-dsh-remote-mobile-layout]')),
        sessionLogLabel: document.querySelector('[data-dsh-remote-session-log]')?.getAttribute('aria-label'),
        footerDisplay: getComputedStyle(document.querySelector('[data-question-key] > section > footer')).display,
        actionsColumns: getComputedStyle(document.querySelector('[data-question-key] > section > footer > :last-child')).gridTemplateColumns,
        card: { left: card.left, right: card.right, width: card.width },
        actions: { left: actions.left, right: actions.right, width: actions.width },
        actionButtons,
        buttonRects
      }
    })()`)

    assert.ok(audit.viewport.width >= 390 && audit.viewport.width <= 400, JSON.stringify(audit.viewport))
    assert.ok(audit.documentWidth <= audit.viewport.width, JSON.stringify(audit))
    assert.equal(audit.hasLayoutStyle, true)
    assert.equal(audit.sessionLogLabel, 'Session log')
    assert.equal(audit.footerDisplay, 'grid')
    assert.ok(audit.card.left >= 64 && audit.card.right <= audit.viewport.width, JSON.stringify(audit.card))
    assert.ok(audit.actions.left >= audit.card.left && audit.actions.right <= audit.card.right, JSON.stringify(audit.actions))
    assert.equal(audit.actionButtons.length, 2)
    assert.ok(audit.actionButtons.every(rect => rect.width >= 80 && rect.height >= 40 && rect.left >= audit.card.left && rect.right <= audit.card.right), JSON.stringify(audit.actionButtons))
    assert.ok(audit.actionButtons[0].right <= audit.actionButtons[1].left)
    assert.ok(audit.buttonRects.every(rect => rect.left >= 0 && rect.right <= audit.viewport.width && rect.top >= 0 && rect.bottom <= audit.viewport.height), JSON.stringify(audit.buttonRects))

    const screenshotPath = process.env.DSH_REMOTE_LAYOUT_SCREENSHOT
    if (screenshotPath) {
      mkdirSync(path.dirname(screenshotPath), { recursive: true })
      const image = await window.webContents.capturePage()
      writeFileSync(screenshotPath, image.toPNG())
    }
    console.log(`mobile-portrait-layout-audit-ok ${JSON.stringify(audit)}`)
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
    app.quit()
  }
}).catch(error => {
  console.error(error)
  app.exit(1)
})
