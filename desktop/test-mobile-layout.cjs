'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const { app, BrowserWindow } = require('electron')
const { createMobileLayoutFixtureServer, listen } = require('./scripts/serve-mobile-layout-fixture.cjs')

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

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
    window.webContents.setUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36')
    await window.loadURL(`http://127.0.0.1:${port}/`)
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const started=Date.now(); const poll=()=>{ if(document.querySelector('[data-dsh-remote-desktop-entry]'))resolve(); else if(Date.now()-started>3000)reject(new Error('desktop entry timed out')); else setTimeout(poll,25) }; poll() })`)
    const audit = await window.webContents.executeJavaScript(`(() => {
      const visibleButtons = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0)
      const buttonRects = visibleButtons.map(button => {
        const rect = button.getBoundingClientRect()
        return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      const card = document.querySelector('[data-question-key] > section').getBoundingClientRect()
      const actions = document.querySelector('[data-question-key] > section > footer > :last-child').getBoundingClientRect()
      const settingsButton = document.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
      const desktopButton = document.querySelector('[data-dsh-remote-desktop-entry]')
      const sendButton = document.querySelector('[data-dsh-remote-send]')
      const rectOf = node => { const rect=node.getBoundingClientRect(); return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height} }
      const actionButtons = [...document.querySelectorAll('[data-question-key] > section > footer > :last-child > button')].map(button => {
        const rect = button.getBoundingClientRect()
        return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        hasLayoutStyle: Boolean(document.querySelector('[data-dsh-remote-mobile-layout]')),
        sessionLogLabel: document.querySelector('[data-dsh-remote-session-log]')?.getAttribute('aria-label'),
        desktopEntryLabel: document.querySelector('[data-dsh-remote-desktop-entry]')?.getAttribute('aria-label'),
        settingsLabel: settingsButton?.getAttribute('aria-label'),
        sidebarFootHeight: document.querySelector('[data-dsh-remote-sidebar-foot]')?.getBoundingClientRect().height,
        settingsButton: rectOf(settingsButton),
        desktopButton: rectOf(desktopButton),
        sendButton: rectOf(sendButton),
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
    assert.equal(audit.desktopEntryLabel, '桌面')
    assert.equal(audit.settingsLabel, '设置')
    assert.ok(audit.sidebarFootHeight >= 94, JSON.stringify(audit))
    assert.ok(audit.desktopButton.bottom <= audit.settingsButton.top, JSON.stringify({ desktop: audit.desktopButton, settings: audit.settingsButton }))
    assert.ok(audit.desktopButton.top >= 0 && audit.settingsButton.bottom <= audit.viewport.height, JSON.stringify(audit))
    assert.ok(audit.sendButton.width >= 33 && audit.sendButton.right <= audit.viewport.width && audit.sendButton.left >= 64, JSON.stringify(audit.sendButton))
    assert.equal(audit.footerDisplay, 'grid')
    assert.ok(audit.card.left >= 64 && audit.card.right <= audit.viewport.width, JSON.stringify(audit.card))
    assert.ok(audit.actions.left >= audit.card.left && audit.actions.right <= audit.card.right, JSON.stringify(audit.actions))
    assert.equal(audit.actionButtons.length, 2)
    assert.ok(audit.actionButtons.every(rect => rect.width >= 80 && rect.height >= 40 && rect.left >= audit.card.left && rect.right <= audit.card.right), JSON.stringify(audit.actionButtons))
    assert.ok(audit.actionButtons[0].right <= audit.actionButtons[1].left)
    assert.ok(audit.buttonRects.every(rect => rect.left >= 0 && rect.right <= audit.viewport.width && rect.top >= 0 && rect.bottom <= audit.viewport.height), JSON.stringify(audit.buttonRects))

    await window.webContents.executeJavaScript(`document.querySelector('[data-dsh-remote-desktop-entry]').click()`)
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const started=Date.now(); const poll=()=>{ const node=document.querySelector('[data-dsh-remote-desktop-viewer]'); if(node&&node.querySelectorAll('select option').length===2)resolve(); else if(Date.now()-started>3000)reject(new Error('viewer timed out')); else setTimeout(poll,25) }; poll() })`)
    const portraitViewer = await window.webContents.executeJavaScript(`(() => { const viewer=document.querySelector('[data-dsh-remote-desktop-viewer]'); const rect=viewer.getBoundingClientRect(); return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,options:viewer.querySelectorAll('select option').length,status:viewer.querySelector('[data-dsh-remote-desktop-status]').textContent,historyState:history.state&&history.state.dshRemoteDesktop} })()`)
    assert.ok(Math.abs(portraitViewer.left) < 1 && Math.abs(portraitViewer.top) < 1 && Math.abs(portraitViewer.right - audit.viewport.width) < 1 && Math.abs(portraitViewer.bottom - audit.viewport.height) < 1, JSON.stringify(portraitViewer))
    assert.equal(portraitViewer.options, 2)
    assert.equal(portraitViewer.historyState, true)
    assert.match(portraitViewer.status, /控制/)

    window.setContentSize(852, 393)
    await new Promise(resolve => setTimeout(resolve, 100))
    const landscapeViewer = await window.webContents.executeJavaScript(`(() => { const viewer=document.querySelector('[data-dsh-remote-desktop-viewer]'); const rect=viewer.getBoundingClientRect(); viewer.querySelector('[data-action="keyboard"]').click(); return {viewport:{width:innerWidth,height:innerHeight},rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},keyboard:getComputedStyle(viewer.querySelector('[data-dsh-remote-keyboard]')).display} })()`)
    assert.ok(landscapeViewer.viewport.width >= 849 && landscapeViewer.viewport.height >= 390, JSON.stringify(landscapeViewer))
    assert.ok(Math.abs(landscapeViewer.rect.left) < 1 && Math.abs(landscapeViewer.rect.top) < 1 && Math.abs(landscapeViewer.rect.right - landscapeViewer.viewport.width) < 1 && Math.abs(landscapeViewer.rect.bottom - landscapeViewer.viewport.height) < 1, JSON.stringify(landscapeViewer))
    assert.equal(landscapeViewer.keyboard, 'grid')

    await window.webContents.executeJavaScript(`history.back()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-dsh-remote-desktop-viewer]'))`), false)

    const driveResult = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const dialog=document.createElement('div'); dialog.setAttribute('role','dialog'); dialog.innerHTML='<div><h2>选择工作区目录</h2></div><button aria-label="编辑路径">编辑路径</button>';
      dialog.querySelector('button').onclick=()=>{ if(dialog.querySelector('input'))return; const input=document.createElement('input'); input.addEventListener('keydown',event=>{if(event.key==='Enter')resolve(input.value)}); dialog.appendChild(input) };
      document.body.appendChild(dialog); const started=Date.now(); const poll=()=>{const button=[...dialog.querySelectorAll('[data-dsh-remote-drive-bar] button')].find(item=>item.textContent==='F:\\\\'); if(button)button.click(); else if(Date.now()-started>3000)reject(new Error('drive bar timed out')); else setTimeout(poll,25)}; poll();
    })`)
    assert.equal(driveResult, 'F:\\')

    const screenshotPath = process.env.DSH_REMOTE_LAYOUT_SCREENSHOT
    if (screenshotPath) {
      mkdirSync(path.dirname(screenshotPath), { recursive: true })
      const image = await window.webContents.capturePage()
      writeFileSync(screenshotPath, image.toPNG())
    }
    console.log(`mobile-portrait-landscape-desktop-layout-audit-ok ${JSON.stringify({ audit, portraitViewer, landscapeViewer })}`)
  } catch (error) {
    process.stderr.write(`${error && (error.stack || error.message) || error}\n`)
    process.exitCode = 1
    throw error
  } finally {
    window.destroy()
    await new Promise(resolve => server.close(resolve))
  }
  app.quit()
}).catch(error => {
  process.stderr.write(`${error && (error.stack || error.message) || error}\n`)
  process.exitCode = 1
  setTimeout(() => app.exit(1), 100)
})
