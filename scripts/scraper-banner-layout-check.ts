import { app, WebContentsView } from 'electron'
import assert from 'node:assert/strict'
import { ScrapeBrowserHelperRuntime } from '../apps/desktop/src/main/scrapers/scrapeBrowserHelperRuntime'

app.whenReady().then(async () => {
  const runtime = new ScrapeBrowserHelperRuntime()
  const win = (runtime as any).ensureWindow() as Electron.BrowserWindow
  try {
    await win.loadURL('data:text/html,<html><body style="margin:0"><button style="width:100px;height:32px" onclick="document.title=\'clicked\'">Login</button></body></html>')
    win.show()
    await new Promise(resolve => setTimeout(resolve, 150))
    const pageView = win.contentView.children.find(v => v instanceof WebContentsView && v.webContents === win.webContents)!
    assert.equal(pageView.getBounds().y, 0, 'idle page must not reserve banner space')
    ;(runtime as any).installPreLoginBanner(win, 'Test')
    for (const width of [1080, 800, 1200]) {
      win.setSize(width, 820)
      await new Promise(resolve => setTimeout(resolve, 150))
      await win.webContents.executeJavaScript("document.title = 'ready'")
      const root = win.contentView
      const page = root instanceof WebContentsView && root.webContents === win.webContents
        ? root : root.children.find(v => v instanceof WebContentsView && v.webContents === win.webContents)
      console.log(JSON.stringify({ root: root.constructor.name, children: root.children.map(v => v.constructor.name), page: page?.getBounds() }))
      assert.ok(page, 'page view must be found')
      assert.equal(page.getBounds().y, 46, 'page top must start below banner')
      assert.equal(page.getBounds().height, root.getBounds().height - 46)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: 25, y: 15, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: 25, y: 15, button: 'left', clickCount: 1 })
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(win.webContents.getTitle(), 'clicked', 'page input must receive clicks')
    }
    ;(runtime as any).completePreLogin(win)
    assert.equal(pageView.getBounds().y, 0, 'login completion must remove reserved space')
    assert.equal(pageView.getBounds().height, win.contentView.getBounds().height)
    assert.equal((runtime as any).helperToolbarView.getVisible(), false)
    ;(runtime as any).installChallengeBanner(win)
    assert.equal(pageView.getBounds().y, 46, 'challenge must restore banner space')
    await (runtime as any).syncHelperBanner(win)
    win.setSize(900, 700)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(pageView.getBounds().y, 0, 'cleared challenge must stay collapsed after resize')
    assert.equal(pageView.getBounds().height, win.contentView.getBounds().height)
    assert.equal((runtime as any).helperToolbarView.getVisible(), false)
    console.log('PASS: banner bounds, page input, completion and resize')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
