/** Real component/styles in an isolated Vite+Chrome fixture; never opens Electron or a personal DB. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repository = process.cwd()
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tag-picker-ui-'))
const output = path.resolve(process.env.JAVDEX_TAG_PICKER_UI_OUTPUT ?? path.join(fixture, 'results'))
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>')
fs.writeFileSync(path.join(fixture, 'fixture.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify('/@fs' + path.join(repository, 'apps/desktop/src/renderer/src/styles/global.css'))};
window.React = React;
window.__requests = []; window.__selected = null; window.__failNext = false;
const rows = Array.from({length:220},(_,i)=>({id:i+1,label:i===1?'L'.repeat(128)+'…':'标签'+String(i+1).padStart(3,'0')}));
window.api = {
  tags:{manualOptions:async(query)=>{
    window.__requests.push(query);
    if(window.__failNext){window.__failNext=false;throw new Error('合成读取失败');}
    const filtered=rows.filter(row=>row.label.toLowerCase().includes((query.search||'').toLowerCase()));
    const offset=query.offset||0,limit=query.limit||100;
    return {items:filtered.slice(offset,offset+limit),hasMore:filtered.length>offset+limit};
  }},
  videos:{addExistingManualTag:async(_videoId,tagId)=>{window.__selected=tagId;return true},addManualTag:async()=>true,removeManualTag:async()=>true}
};
const Panel=(await import(${JSON.stringify('/@fs' + path.join(repository, 'apps/desktop/src/renderer/src/components/VideoTagPanel.tsx'))})).default;
createRoot(document.getElementById('root')).render(React.createElement(Panel,{videoId:1,tags:[],onFilterTag:()=>{},onChanged:()=>{}}));
`)
let server, browser
const results = []
try {
  server = await createServer({ configFile: false, root: fixture, cacheDir: path.join(fixture, '.vite'),
    plugins: [react()], resolve: { alias: {
      '@shared': path.join(repository, 'packages/contracts/src'),
      react: path.join(repository, 'node_modules/react'),
      'react-dom': path.join(repository, 'node_modules/react-dom')
    } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [fixture, repository] } } })
  await server.listen()
  const port = server.httpServer.address().port
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  for (const viewport of [{ width: 1000, height: 640 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}`)
    await page.getByRole('button', { name: '添加自定义标签', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__requests.length), 0)
    await page.getByRole('button', { name: '添加自定义标签', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('button[aria-pressed]').length === 100)
    const dialog = page.getByRole('dialog')
    const scroll = page.locator('.video-tag-add-modal-catalog-scroll')
    const geometry = await scroll.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
    const box = await dialog.boundingBox()
    await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}.png`) })
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1)
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, JSON.stringify(geometry))
    await page.getByRole('navigation', { name: '标签候选分页' }).getByRole('button', { name: '下一页' }).click()
    await page.getByText('按名称 · 第 2 页 · 100 项', { exact: true }).waitFor()
    await page.getByRole('button', { name: '标签101', exact: true }).click()
    await page.waitForFunction(() => window.__selected === 101)
    await dialog.waitFor({ state: 'hidden' })
    await page.evaluate(() => { window.__failNext = true })
    await page.getByRole('button', { name: '添加自定义标签', exact: true }).click()
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('button[aria-pressed]').length === 100)
    await page.getByLabel('标签名称', { exact: true }).fill('标签21')
    await page.waitForFunction(() => document.querySelectorAll('button[aria-pressed]').length === 10)
    assert.deepEqual(errors, [])
    const requests = await page.evaluate(() => window.__requests)
    assert.ok(requests.every(query => query.limit === 100))
    results.push({ viewport, geometry, box, requests, selectedTagId: 101, pageErrors: errors })
    await page.close()
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results,
    caveats: ['Actual React component and stylesheet, mocked IPC and synthetic names.', 'Headless Chrome at supported minimum and larger desktop sizes; not native Electron, customer data, timing benchmark, or complete keyboard journey.'] }, null, 2) + '\n')
  console.log(JSON.stringify({ output, results: results.length }))
} finally {
  await browser?.close()
  await server?.close()
  // Keep requested output; remove only the fixture created by this process.
  if (output.startsWith(fixture + path.sep)) console.log(`Temporary screenshots retained at ${output}`)
  else fs.rmSync(fixture, { recursive: true, force: true })
}
