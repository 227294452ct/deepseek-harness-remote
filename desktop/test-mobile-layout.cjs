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
    window.setContentSize(360, 792)
    await new Promise(resolve => setTimeout(resolve, 80))
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const started=Date.now(); const poll=()=>{ if(document.querySelector('[data-dsh-remote-desktop-entry]'))resolve(); else if(Date.now()-started>3000)reject(new Error('desktop entry timed out')); else setTimeout(poll,25) }; poll() })`)
    const audit = await window.webContents.executeJavaScript(`(() => {
      const visibleButtons = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0 && !button.closest('[inert]') && getComputedStyle(button).visibility !== 'hidden')
      const buttonRects = visibleButtons.map(button => {
        const rect = button.getBoundingClientRect()
        return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      const card = document.querySelector('[data-question-key] > section').getBoundingClientRect()
      const actions = document.querySelector('[data-question-key] > section > footer > :last-child').getBoundingClientRect()
      const settingsButton = document.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
      const desktopButton = document.querySelector('[data-dsh-remote-desktop-entry]')
      const topbar = document.querySelector('[data-dsh-remote-mobile-topbar]')
      const topbarDesktop = topbar.querySelector('[data-dsh-mobile-action="desktop"]')
      const topbarSettings = topbar.querySelector('[data-dsh-mobile-action="settings"]')
      const heroMark = document.querySelector('[data-dsh-remote-hero-mark-wrap]')
      const sendButton = document.querySelector('[data-dsh-remote-send]')
      const heroHeading = document.querySelector('[data-dsh-remote-composer-heading]')
      const heroHeadline = heroHeading?.querySelector('.hero-headline')
      const composerCard = document.querySelector('[data-dsh-remote-home-composer] [data-dsh-remote-composer-card]')
      const uploadControls = document.querySelector('[data-dsh-remote-upload-controls]')
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
        topbar: rectOf(topbar),
        topbarActions: [...topbar.querySelectorAll('[data-dsh-mobile-action]')].map(node => node.getAttribute('data-dsh-mobile-action')),
        topbarDesktop: rectOf(topbarDesktop),
        topbarSettings: rectOf(topbarSettings),
        sidebarInert: document.querySelector('[data-dsh-remote-sidebar-column]').inert,
        sidebarFootHeight: document.querySelector('[data-dsh-remote-sidebar-foot]')?.getBoundingClientRect().height,
        sendButton: rectOf(sendButton),
        composerCard: rectOf(composerCard),
        uploadActions: [...uploadControls.querySelectorAll('[data-dsh-remote-upload-action]')].map(node => node.getAttribute('data-dsh-remote-upload-action')),
        uploadButtons: [...uploadControls.querySelectorAll('button')].map(rectOf),
        heroHeading: rectOf(heroHeading),
        heroHeadingClass: heroHeading?.className,
        heroHeadline: heroHeadline ? rectOf(heroHeadline) : null,
        heroMark: heroMark ? rectOf(heroMark) : null,
        heroMarkPointerEvents: heroMark ? getComputedStyle(heroMark).pointerEvents : null,
        footerDisplay: getComputedStyle(document.querySelector('[data-question-key] > section > footer')).display,
        actionsColumns: getComputedStyle(document.querySelector('[data-question-key] > section > footer > :last-child')).gridTemplateColumns,
        card: { left: card.left, right: card.right, width: card.width },
        actions: { left: actions.left, right: actions.right, width: actions.width },
        actionButtons,
        buttonRects
      }
    })()`)

    assert.ok(audit.viewport.width >= 358 && audit.viewport.width <= 362, JSON.stringify(audit.viewport))
    assert.ok(audit.documentWidth <= audit.viewport.width, JSON.stringify(audit))
    assert.equal(audit.hasLayoutStyle, true)
    assert.equal(audit.sessionLogLabel, 'Session log')
    assert.equal(audit.desktopEntryLabel, '桌面')
    assert.equal(audit.settingsLabel, '设置')
    assert.ok(audit.topbar.left === 0 && audit.topbar.right === audit.viewport.width && audit.topbar.height >= 55, JSON.stringify(audit.topbar))
    assert.deepEqual(audit.topbarActions, ['menu', 'desktop', 'settings'], JSON.stringify(audit.topbarActions))
    assert.equal(audit.sidebarInert, true)
    assert.ok(audit.sidebarFootHeight >= 94, JSON.stringify(audit))
    assert.ok(audit.topbarDesktop.top >= 0 && audit.topbarSettings.bottom <= audit.viewport.height, JSON.stringify(audit))
    assert.ok(audit.sendButton.width >= 41 && audit.sendButton.right <= audit.viewport.width && audit.sendButton.left >= 18, JSON.stringify(audit.sendButton))
    assert.ok(audit.composerCard.left >= 18 && audit.composerCard.right <= audit.viewport.width - 18 && audit.composerCard.top >= 0 && audit.composerCard.bottom <= audit.viewport.height && audit.composerCard.height >= 248, JSON.stringify(audit.composerCard))
    assert.deepEqual(audit.uploadActions, ['gallery', 'camera'], JSON.stringify(audit.uploadActions))
    assert.ok(audit.uploadButtons.every(rect => rect.width >= 58 && rect.height >= 33 && rect.left >= audit.composerCard.left && rect.right <= audit.composerCard.right), JSON.stringify(audit.uploadButtons))
    assert.equal(audit.heroHeadingClass, 'hero-heading', JSON.stringify(audit))
    assert.ok(audit.heroHeading.height >= 86 && audit.heroHeading.height <= 122, JSON.stringify(audit.heroHeading))
    assert.ok(audit.heroHeadline.height >= 86 && audit.heroHeadline.height <= 122, JSON.stringify(audit.heroHeadline))
    assert.ok(audit.heroMark.top >= audit.heroHeadline.top && audit.heroMark.bottom < audit.heroHeadline.bottom, JSON.stringify(audit.heroMark))
    assert.equal(audit.heroMarkPointerEvents, 'none')
    assert.equal(audit.footerDisplay, 'grid')
    assert.ok(audit.card.left >= 0 && audit.card.right <= audit.viewport.width, JSON.stringify(audit.card))
    assert.ok(audit.actions.left >= audit.card.left && audit.actions.right <= audit.card.right, JSON.stringify(audit.actions))
    assert.equal(audit.actionButtons.length, 2)
    assert.ok(audit.actionButtons.every(rect => rect.width >= 80 && rect.height >= 40 && rect.left >= audit.card.left && rect.right <= audit.card.right), JSON.stringify(audit.actionButtons))
    assert.ok(audit.actionButtons[0].right <= audit.actionButtons[1].left)
    assert.ok(audit.buttonRects.every(rect => rect.left >= 0 && rect.right <= audit.viewport.width && rect.top >= 0 && rect.bottom <= audit.viewport.height), JSON.stringify(audit.buttonRects))

    const uploadAudit = await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#image-upload')
      const captures = []
      input.click = () => captures.push({ capture: input.getAttribute('capture'), accept: input.getAttribute('accept'), multiple: input.multiple })
      document.querySelector('[data-dsh-remote-upload-action="gallery"]').click()
      document.querySelector('[data-dsh-remote-upload-action="camera"]').click()
      input.dispatchEvent(new Event('change'))
      return { captures, captureAfterChange: input.getAttribute('capture') }
    })()`)
    assert.deepEqual(uploadAudit, {
      captures: [
        { capture: null, accept: 'image/*', multiple: true },
        { capture: 'environment', accept: 'image/*', multiple: true }
      ],
      captureAfterChange: null
    }, JSON.stringify(uploadAudit))

    const uploadBridgeAudit = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#image-upload').remove()
      const nativeClick = HTMLInputElement.prototype.click
      HTMLInputElement.prototype.click = () => {}
      document.querySelector('[data-dsh-remote-upload-action="gallery"]').click()
      HTMLInputElement.prototype.click = nativeClick
      const bridge = document.querySelector('[data-dsh-remote-image-bridge]')
      if (!bridge) throw new Error('fallback image bridge was not created')
      const picked = new DataTransfer()
      picked.items.add(new File(['fixture'], 'fixture-photo.jpg', { type: 'image/jpeg' }))
      Object.defineProperty(bridge, 'files', { configurable: true, value: picked.files })
      const drops = []
      document.addEventListener('drop', event => {
        drops.push(Array.from(event.dataTransfer.files).map(file => ({ name: file.name, type: file.type })))
      }, { once: true })
      bridge.click = () => bridge.dispatchEvent(new Event('change'))
      document.querySelector('[data-dsh-remote-upload-action="gallery"]').click()
      await new Promise(resolve => setTimeout(resolve, 0))
      return {
        accept: bridge.getAttribute('accept'),
        multiple: bridge.multiple,
        captureAfterChange: bridge.getAttribute('capture'),
        drops
      }
    })()`)
    assert.deepEqual(uploadBridgeAudit, {
      accept: 'image/*',
      multiple: true,
      captureAfterChange: null,
      drops: [[{ name: 'fixture-photo.jpg', type: 'image/jpeg' }]]
    }, JSON.stringify(uploadBridgeAudit))

    const modelMenuAudit = await window.webContents.executeJavaScript(`(() => {
      const question=document.querySelector('[data-question-key]'); question.style.visibility='hidden';
      const modelButton=document.querySelector('button[aria-label^="选择模型"]'); modelButton.click();
      const menu=modelButton.parentElement.querySelector('[role="menu"]'); const rect=menu.getBoundingClientRect(); const trailing=menu.closest('[data-dsh-remote-composer-trailing]');
      const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      return {expanded:modelButton.getAttribute('aria-expanded'),hidden:menu.hidden,rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height},trailingOverflow:getComputedStyle(trailing).overflow,hitMenu:Boolean(hit&&hit.closest('[role="menu"]'))};
    })()`)
    assert.equal(modelMenuAudit.expanded, 'true', JSON.stringify(modelMenuAudit))
    assert.equal(modelMenuAudit.hidden, false, JSON.stringify(modelMenuAudit))
    assert.equal(modelMenuAudit.trailingOverflow, 'visible', JSON.stringify(modelMenuAudit))
    assert.equal(modelMenuAudit.hitMenu, true, JSON.stringify(modelMenuAudit))
    assert.ok(modelMenuAudit.rect.left >= 18 && modelMenuAudit.rect.right <= audit.viewport.width && modelMenuAudit.rect.top >= 0 && modelMenuAudit.rect.bottom <= audit.viewport.height, JSON.stringify(modelMenuAudit))
    const modelClosed = await window.webContents.executeJavaScript(`(() => { const button=document.querySelector('button[aria-label^="选择模型"]'); button.click(); const menu=button.parentElement.querySelector('[role="menu"]'); document.querySelector('[data-question-key]').style.visibility=''; return {expanded:button.getAttribute('aria-expanded'),hidden:menu.hidden,display:getComputedStyle(menu).display} })()`)
    assert.deepEqual(modelClosed, { expanded: 'false', hidden: true, display: 'none' }, JSON.stringify(modelClosed))

    const navAudit = await window.webContents.executeJavaScript(`(async () => { const trigger=document.querySelector('[data-dsh-mobile-action="menu"]'); trigger.click(); const sidebar=document.querySelector('[data-dsh-remote-sidebar-column]'); let rect=sidebar.getBoundingClientRect(); const opened={open:document.documentElement.hasAttribute('data-dsh-mobile-nav-open'),inert:sidebar.inert,visibility:getComputedStyle(sidebar).visibility,left:rect.left,right:rect.right,height:rect.height}; document.querySelector('button[aria-label="搜索会话"]').click(); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); rect=sidebar.getBoundingClientRect(); const input=sidebar.querySelector('input').getBoundingClientRect(); const result=sidebar.querySelector('.drawer-copy p').getBoundingClientRect(); const expanded={marked:sidebar.hasAttribute('data-dsh-remote-sidebar-expanded'),left:rect.left,right:rect.right,width:rect.width,height:rect.height,input:{left:input.left,right:input.right,width:input.width},result:{left:result.left,right:result.right,width:result.width}}; trigger.click(); return {opened,expanded,closed:{open:document.documentElement.hasAttribute('data-dsh-mobile-nav-open'),inert:sidebar.inert,visibility:getComputedStyle(sidebar).visibility}} })()`)
    assert.deepEqual(navAudit.opened, { open: true, inert: false, visibility: 'visible', left: 0, right: 64, height: audit.viewport.height - 56 }, JSON.stringify(navAudit))
    assert.equal(navAudit.expanded.marked, true, JSON.stringify(navAudit))
    assert.ok(navAudit.expanded.width >= 270 && navAudit.expanded.right <= audit.viewport.width, JSON.stringify(navAudit))
    assert.equal(navAudit.expanded.height, audit.viewport.height - 56, JSON.stringify(navAudit))
    assert.ok(navAudit.expanded.input.width >= 150 && navAudit.expanded.input.left >= 56 && navAudit.expanded.input.right <= navAudit.expanded.right, JSON.stringify(navAudit))
    assert.ok(navAudit.expanded.result.width >= 150 && navAudit.expanded.result.left >= 56 && navAudit.expanded.result.right <= navAudit.expanded.right, JSON.stringify(navAudit))
    assert.deepEqual(navAudit.closed, { open: false, inert: true, visibility: 'hidden' }, JSON.stringify(navAudit))

    const settingsAudit = await window.webContents.executeJavaScript(`(async () => {
      const source=document.querySelector('[data-dsh-remote-sidebar-settings] button[aria-haspopup="dialog"]');
      document.querySelector('[data-dsh-mobile-action="settings"]').click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const dialog=document.querySelector('[role="dialog"]'); const rect=dialog.getBoundingClientRect();
      return {expanded:source.getAttribute('aria-expanded'),opened:document.documentElement.hasAttribute('data-fixture-settings-open'),mobileSettingsOpen:document.documentElement.hasAttribute('data-dsh-mobile-settings-open'),sidebarInert:document.querySelector('[data-dsh-remote-sidebar-column]').inert,dialog:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};
    })()`)
    assert.equal(settingsAudit.expanded, 'true', JSON.stringify(settingsAudit))
    assert.equal(settingsAudit.opened, true, JSON.stringify(settingsAudit))
    assert.equal(settingsAudit.mobileSettingsOpen, true, JSON.stringify(settingsAudit))
    assert.equal(settingsAudit.sidebarInert, false, JSON.stringify(settingsAudit))
    assert.ok(Math.abs(settingsAudit.dialog.left) < 1 && Math.abs(settingsAudit.dialog.top - 56) < 1 && Math.abs(settingsAudit.dialog.right - audit.viewport.width) < 1 && Math.abs(settingsAudit.dialog.bottom - audit.viewport.height) < 1, JSON.stringify(settingsAudit.dialog))
    await window.webContents.executeJavaScript(`document.querySelector('[data-fixture-settings-close]').click()`)
    const settingsClosed = await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(() => { const sidebar=document.querySelector('[data-dsh-remote-sidebar-column]'); resolve({expanded:document.querySelector('[data-dsh-remote-sidebar-settings] button[aria-haspopup="dialog"]').getAttribute('aria-expanded'),mobileSettingsOpen:document.documentElement.hasAttribute('data-dsh-mobile-settings-open'),sidebarInert:sidebar.inert,dialog:Boolean(document.querySelector('[role="dialog"]'))}) }, 80))`)
    assert.deepEqual(settingsClosed, { expanded: 'false', mobileSettingsOpen: false, sidebarInert: true, dialog: false }, JSON.stringify(settingsClosed))

    const homeScreenshotPath = process.env.DSH_REMOTE_HOME_SCREENSHOT
    if (homeScreenshotPath) {
      await window.webContents.executeJavaScript(`(() => { const question=document.querySelector('[data-question-key]'); window.__dshQuestionCapture={node:question,parent:question.parentElement,next:question.nextSibling}; question.remove(); document.querySelectorAll('[role="menu"]').forEach(menu=>{menu.hidden=true}) })()`)
      await new Promise(resolve => setTimeout(resolve, 40))
      mkdirSync(path.dirname(homeScreenshotPath), { recursive: true })
      writeFileSync(homeScreenshotPath, (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript(`(() => { const saved=window.__dshQuestionCapture; if(saved.next&&saved.next.parentElement===saved.parent)saved.parent.insertBefore(saved.node,saved.next); else saved.parent.appendChild(saved.node); delete window.__dshQuestionCapture })()`)
    }

    await window.webContents.executeJavaScript(`document.querySelector('[data-dsh-mobile-action="desktop"]').click()`)
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const started=Date.now(); const poll=()=>{ const node=document.querySelector('[data-dsh-remote-desktop-viewer]'); if(node&&node.querySelectorAll('select option').length===2)resolve(); else if(Date.now()-started>3000)reject(new Error('viewer timed out')); else setTimeout(poll,25) }; poll() })`)
    const portraitViewer = await window.webContents.executeJavaScript(`(() => { const viewer=document.querySelector('[data-dsh-remote-desktop-viewer]'); const rect=viewer.getBoundingClientRect(); return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,options:viewer.querySelectorAll('select option').length,status:viewer.querySelector('[data-dsh-remote-desktop-status]').textContent,historyState:history.state&&history.state.dshRemoteDesktop} })()`)
    assert.ok(Math.abs(portraitViewer.left) < 1 && Math.abs(portraitViewer.top) < 1 && Math.abs(portraitViewer.right - audit.viewport.width) < 1 && Math.abs(portraitViewer.bottom - audit.viewport.height) < 1, JSON.stringify(portraitViewer))
    assert.equal(portraitViewer.options, 2)
    assert.equal(portraitViewer.historyState, true)
    assert.match(portraitViewer.status, /控制/)

    const tapStartedAt = Date.now()
    await window.webContents.executeJavaScript(`(async () => {
      const stage=document.querySelector('[data-dsh-remote-desktop-stage]'); const image=stage.querySelector('img');
      image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="black"/></svg>'); await image.decode();
      const rect=stage.getBoundingClientRect(); const scale=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight); const shownHeight=image.naturalHeight*scale; const shownTop=rect.top+(rect.height-shownHeight)/2; const x=rect.left+rect.width/2; const y=shownTop+shownHeight*.1;
      const init={identifier:1,target:stage,clientX:x,clientY:y,pageX:x,pageY:y,screenX:x,screenY:y};
      const start=new Touch(init); stage.dispatchEvent(new TouchEvent('touchstart',{touches:[start],targetTouches:[start],changedTouches:[start],bubbles:true,cancelable:true}));
      const end=new Touch(init); stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[end],bubbles:true,cancelable:true}));
    })()`)
    while (!server.desktopMessages.some(item => item.value.type === 'pointer' && item.value.action === 'click') && Date.now() - tapStartedAt < 260) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const tapMessage = server.desktopMessages.find(item => item.value.type === 'pointer' && item.value.action === 'click')
    assert.ok(tapMessage, `tap was not sent immediately: ${JSON.stringify(server.desktopMessages)}`)
    assert.ok(tapMessage.receivedAt - tapStartedAt < 260, JSON.stringify(tapMessage))
    assert.ok(Math.abs(tapMessage.value.x - 0.5) < 0.02 && Math.abs(tapMessage.value.y - 0.1) < 0.02, JSON.stringify(tapMessage.value))

    server.desktopMessages.length = 0
    const jitterPoint = await window.webContents.executeJavaScript(`(() => {
      const stage=document.querySelector('[data-dsh-remote-desktop-stage]'); const image=stage.querySelector('img'); const rect=stage.getBoundingClientRect();
      const scale=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight); const shownWidth=image.naturalWidth*scale; const shownHeight=image.naturalHeight*scale; const left=rect.left+(rect.width-shownWidth)/2; const top=rect.top+(rect.height-shownHeight)/2;
      const x=left+shownWidth*.45,y=top+shownHeight*.45; const touch=(id,tx,ty)=>new Touch({identifier:id,target:stage,clientX:tx,clientY:ty,pageX:tx,pageY:ty,screenX:tx,screenY:ty});
      const start=touch(11,x,y),moved=touch(11,x+15,y+2);
      stage.dispatchEvent(new TouchEvent('touchstart',{touches:[start],targetTouches:[start],changedTouches:[start],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchmove',{touches:[moved],targetTouches:[moved],changedTouches:[moved],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[moved],bubbles:true,cancelable:true}));
      return {x:(x-left)/shownWidth,y:(y-top)/shownHeight};
    })()`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const jitterPointers = server.desktopMessages.filter(item => item.value.type === 'pointer').map(item => item.value)
    assert.deepEqual(jitterPointers.map(item => item.action), ['click'], JSON.stringify(jitterPointers))
    assert.ok(Math.abs(jitterPointers[0].x - jitterPoint.x) < 0.01 && Math.abs(jitterPointers[0].y - jitterPoint.y) < 0.01, JSON.stringify({ jitterPointers, jitterPoint }))

    server.desktopMessages.length = 0
    await window.webContents.executeJavaScript(`(() => {
      const stage=document.querySelector('[data-dsh-remote-desktop-stage]'); const image=stage.querySelector('img'); const rect=stage.getBoundingClientRect();
      const scale=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight); const shownWidth=image.naturalWidth*scale; const shownHeight=image.naturalHeight*scale; const left=rect.left+(rect.width-shownWidth)/2; const top=rect.top+(rect.height-shownHeight)/2;
      const x=left+shownWidth*.4,y=top+shownHeight*.5; const touch=(id,tx,ty)=>new Touch({identifier:id,target:stage,clientX:tx,clientY:ty,pageX:tx,pageY:ty,screenX:tx,screenY:ty});
      const start=touch(21,x,y),moved=touch(21,x+36,y+3),outside=touch(21,left+shownWidth+40,y+3);
      stage.dispatchEvent(new TouchEvent('touchstart',{touches:[start],targetTouches:[start],changedTouches:[start],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchmove',{touches:[moved],targetTouches:[moved],changedTouches:[moved],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchmove',{touches:[outside],targetTouches:[outside],changedTouches:[outside],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[outside],bubbles:true,cancelable:true}));
    })()`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const dragPointers = server.desktopMessages.filter(item => item.value.type === 'pointer').map(item => item.value)
    assert.deepEqual(dragPointers.map(item => item.action), ['down', 'move', 'up'], JSON.stringify(dragPointers))
    assert.ok(Math.abs(dragPointers[1].x - dragPointers[2].x) < 0.001 && Math.abs(dragPointers[1].y - dragPointers[2].y) < 0.001, JSON.stringify(dragPointers))
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-dsh-remote-desktop-viewer]'))`), true)

    server.desktopMessages.length = 0
    await window.webContents.executeJavaScript(`(() => {
      const stage=document.querySelector('[data-dsh-remote-desktop-stage]'); const rect=stage.getBoundingClientRect(); const x=rect.left+rect.width*.45,y=rect.top+rect.height*.55; const touch=(id,tx,ty)=>new Touch({identifier:id,target:stage,clientX:tx,clientY:ty,pageX:tx,pageY:ty,screenX:tx,screenY:ty});
      const start=touch(31,x,y),moved=touch(31,x+32,y),cancelled=touch(31,rect.right+30,y);
      stage.dispatchEvent(new TouchEvent('touchstart',{touches:[start],targetTouches:[start],changedTouches:[start],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchmove',{touches:[moved],targetTouches:[moved],changedTouches:[moved],bubbles:true,cancelable:true}));
      stage.dispatchEvent(new TouchEvent('touchcancel',{touches:[],targetTouches:[],changedTouches:[cancelled],bubbles:true,cancelable:true}));
    })()`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const cancelPointers = server.desktopMessages.filter(item => item.value.type === 'pointer').map(item => item.value)
    assert.deepEqual(cancelPointers.map(item => item.action), ['down', 'move', 'up'], JSON.stringify(cancelPointers))

    server.desktopMessages.length = 0
    await window.webContents.executeJavaScript(`(() => {
      const stage=document.querySelector('[data-dsh-remote-desktop-stage]'); const rect=stage.getBoundingClientRect(); const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
      for(let id=41;id<=43;id+=1){const touch=new Touch({identifier:id,target:stage,clientX:x,clientY:y,pageX:x,pageY:y,screenX:x,screenY:y});stage.dispatchEvent(new TouchEvent('touchstart',{touches:[touch],targetTouches:[touch],changedTouches:[touch],bubbles:true,cancelable:true}));stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[touch],bubbles:true,cancelable:true}))}
    })()`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const rapidPointers = server.desktopMessages.filter(item => item.value.type === 'pointer').map(item => item.value)
    assert.deepEqual(rapidPointers.map(item => item.action), ['click', 'click', 'click'], JSON.stringify(rapidPointers))

    const zoomResult = await window.webContents.executeJavaScript(`(() => {
      const stage=document.querySelector('[data-dsh-remote-desktop-stage]'); const image=stage.querySelector('img'); const rect=stage.getBoundingClientRect(); const cx=rect.left+rect.width/2; const cy=rect.top+rect.height/2;
      const touch=(id,x)=>new Touch({identifier:id,target:stage,clientX:x,clientY:cy,pageX:x,pageY:cy,screenX:x,screenY:cy});
      const a=touch(1,cx-60),b=touch(2,cx+60); stage.dispatchEvent(new TouchEvent('touchstart',{touches:[a,b],targetTouches:[a,b],changedTouches:[a,b],bubbles:true,cancelable:true}));
      const c=touch(1,cx-24),d=touch(2,cx+24); stage.dispatchEvent(new TouchEvent('touchmove',{touches:[c,d],targetTouches:[c,d],changedTouches:[c,d],bubbles:true,cancelable:true}));
      const zoomed=getComputedStyle(image).transform; stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[c,d],bubbles:true,cancelable:true}));
      document.querySelector('[data-action="fit"]').click(); return {zoomed,fit:getComputedStyle(image).transform};
    })()`)
    assert.match(zoomResult.zoomed, /^matrix\(0\.[34]/, JSON.stringify(zoomResult))
    assert.equal(zoomResult.fit, 'matrix(1, 0, 0, 1, 0, 0)')

    window.setContentSize(852, 393)
    await new Promise(resolve => setTimeout(resolve, 100))
    const landscapeViewer = await window.webContents.executeJavaScript(`(() => {
      const viewer=document.querySelector('[data-dsh-remote-desktop-viewer]'); const rect=viewer.getBoundingClientRect(); const stage=viewer.querySelector('[data-dsh-remote-desktop-stage]'); const image=stage.querySelector('img');
      viewer.querySelector('[data-action="keyboard"]').click();
      const stageRect=stage.getBoundingClientRect(); const controls=[...viewer.querySelectorAll('[data-dsh-remote-desktop-toolbar] button,[data-dsh-remote-desktop-toolbar] select')].map(node=>{const value=node.getBoundingClientRect();return{left:value.left,right:value.right,top:value.top,bottom:value.bottom}});
      return {viewport:{width:innerWidth,height:innerHeight},visualViewport:window.visualViewport&&{left:window.visualViewport.offsetLeft,top:window.visualViewport.offsetTop,width:window.visualViewport.width,height:window.visualViewport.height},rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},scroll:{width:viewer.scrollWidth,height:viewer.scrollHeight},stage:{left:stageRect.left,top:stageRect.top,right:stageRect.right,bottom:stageRect.bottom},controls,boxSizing:getComputedStyle(viewer).boxSizing,objectFit:getComputedStyle(image).objectFit,keyboard:getComputedStyle(viewer.querySelector('[data-dsh-remote-keyboard]')).display}
    })()`)
    assert.ok(landscapeViewer.viewport.width >= 849 && landscapeViewer.viewport.height >= 390, JSON.stringify(landscapeViewer))
    assert.ok(Math.abs(landscapeViewer.rect.left) < 1 && Math.abs(landscapeViewer.rect.top) < 1 && Math.abs(landscapeViewer.rect.right - landscapeViewer.viewport.width) < 1 && Math.abs(landscapeViewer.rect.bottom - landscapeViewer.viewport.height) < 1, JSON.stringify(landscapeViewer))
    assert.ok(!landscapeViewer.visualViewport || (Math.abs(landscapeViewer.rect.left - landscapeViewer.visualViewport.left) < 1 && Math.abs(landscapeViewer.rect.top - landscapeViewer.visualViewport.top) < 1 && Math.abs((landscapeViewer.rect.right - landscapeViewer.rect.left) - landscapeViewer.visualViewport.width) < 1 && Math.abs((landscapeViewer.rect.bottom - landscapeViewer.rect.top) - landscapeViewer.visualViewport.height) < 1), JSON.stringify(landscapeViewer))
    assert.ok(landscapeViewer.scroll.width <= landscapeViewer.viewport.width && landscapeViewer.scroll.height <= landscapeViewer.viewport.height, JSON.stringify(landscapeViewer))
    assert.ok(landscapeViewer.stage.left >= 0 && landscapeViewer.stage.right <= landscapeViewer.viewport.width && landscapeViewer.stage.top >= 0 && landscapeViewer.stage.bottom <= landscapeViewer.viewport.height, JSON.stringify(landscapeViewer))
    assert.ok(landscapeViewer.controls.every(rect => rect.left >= 0 && rect.right <= landscapeViewer.viewport.width && rect.top >= 0 && rect.bottom <= landscapeViewer.viewport.height), JSON.stringify(landscapeViewer.controls))
    assert.equal(landscapeViewer.boxSizing, 'border-box')
    assert.equal(landscapeViewer.objectFit, 'contain')
    assert.equal(landscapeViewer.keyboard, 'grid')

    server.desktopMessages.length = 0
    const zoomedTaskbarPoint = await window.webContents.executeJavaScript(`(() => {
      const viewer=document.querySelector('[data-dsh-remote-desktop-viewer]'); viewer.querySelector('[data-action="keyboard"]').click();
      const stage=viewer.querySelector('[data-dsh-remote-desktop-stage]'),image=stage.querySelector('img'),rect=stage.getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
      const touch=(id,x,y)=>new Touch({identifier:id,target:stage,clientX:x,clientY:y,pageX:x,pageY:y,screenX:x,screenY:y});
      const a=touch(71,cx-80,cy),b=touch(72,cx+80,cy); stage.dispatchEvent(new TouchEvent('touchstart',{touches:[a,b],targetTouches:[a,b],changedTouches:[a,b],bubbles:true,cancelable:true}));
      const c=touch(71,cx-120,cy-100),d=touch(72,cx+120,cy-100); stage.dispatchEvent(new TouchEvent('touchmove',{touches:[c,d],targetTouches:[c,d],changedTouches:[c,d],bubbles:true,cancelable:true})); stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[c,d],bubbles:true,cancelable:true}));
      const fit=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight),baseWidth=image.naturalWidth*fit,baseHeight=image.naturalHeight*fit,baseLeft=rect.left+(rect.width-baseWidth)/2,baseTop=rect.top+(rect.height-baseHeight)/2;
      const target={x:baseLeft+baseWidth*.5,y:baseTop+baseHeight*.97},origin={x:cx,y:cy},matrix=new DOMMatrixReadOnly(getComputedStyle(image).transform),visual=new DOMPoint(target.x-origin.x,target.y-origin.y).matrixTransform(matrix),client={x:origin.x+visual.x,y:origin.y+visual.y};
      const tap=touch(73,client.x,client.y); stage.dispatchEvent(new TouchEvent('touchstart',{touches:[tap],targetTouches:[tap],changedTouches:[tap],bubbles:true,cancelable:true})); stage.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[tap],bubbles:true,cancelable:true}));
      return {client,stage:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},transform:getComputedStyle(image).transform};
    })()`)
    await new Promise(resolve => setTimeout(resolve, 80))
    const zoomedTaskbarClick = server.desktopMessages.find(item => item.value.type === 'pointer' && item.value.action === 'click')?.value
    assert.ok(zoomedTaskbarPoint.client.x >= zoomedTaskbarPoint.stage.left && zoomedTaskbarPoint.client.x <= zoomedTaskbarPoint.stage.right && zoomedTaskbarPoint.client.y >= zoomedTaskbarPoint.stage.top && zoomedTaskbarPoint.client.y <= zoomedTaskbarPoint.stage.bottom, JSON.stringify(zoomedTaskbarPoint))
    assert.ok(zoomedTaskbarClick && Math.abs(zoomedTaskbarClick.x - 0.5) < 0.01 && Math.abs(zoomedTaskbarClick.y - 0.97) < 0.01, JSON.stringify({ zoomedTaskbarPoint, zoomedTaskbarClick, messages: server.desktopMessages }))
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="fit"]').click()`)

    await window.webContents.executeJavaScript(`history.back()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-dsh-remote-desktop-viewer]'))`), true)
    assert.equal(await window.webContents.executeJavaScript(`Boolean(history.state&&history.state.dshRemoteDesktop)`), true)

    await window.webContents.executeJavaScript(`document.querySelector('[data-action="back"]').click()`)
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
