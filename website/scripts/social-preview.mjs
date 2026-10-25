// Brand layout with the official icon and an actual, isolated Electron capture.
// Run capture.mjs --social first; no synthetic reconstruction of application UI.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/marketing')
const images = path.join(root, 'docs/images')
mkdirSync(output, { recursive: true }); mkdirSync(images, { recursive: true })
const image = (file, type = 'png') => `data:image/${type};base64,${readFileSync(path.join(root, file)).toString('base64')}`
const logo = image('resources/icon.png')
const library = image('output/playwright/website-product-profile/social/screenshots/library.png')
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Javdex social preview</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:640px;overflow:hidden}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#f3f7fb;color:#203245}
.poster{position:relative;width:1280px;height:640px;isolation:isolate;background:radial-gradient(ellipse at 78% 22%,#cee6f5a0,transparent 62%),linear-gradient(125deg,#ffffff,#f3f7fb 54%,#e6f0f8)}
.facet{position:absolute;inset:0;width:100%;height:100%;z-index:-1}
.halo{position:absolute;left:18px;top:32px;width:338px;height:338px;background:radial-gradient(circle,#84c6ef29,transparent 68%)}
.copy{position:absolute;left:62px;top:76px;width:424px;z-index:2}
.icon{display:block;width:168px;height:168px;object-fit:contain;margin:0 0 14px -12px;filter:drop-shadow(0 10px 26px #1686c518)}
.brand{font-size:78px;line-height:1.16;font-weight:650;letter-spacing:-3.4px;margin:0 0 20px}
.brand span{color:#278bc7}
h1{font-size:28px;line-height:1.4;letter-spacing:1px;margin:0 0 16px;font-weight:500;white-space:nowrap}
.description{font-size:18px;line-height:1.8;color:#5c7488;margin:0;letter-spacing:.5px}
.platforms{display:flex;align-items:center;gap:14px;margin-top:37px;color:#456075;font-size:14px;letter-spacing:.2px}
.platforms b{width:3px;height:3px;border-radius:100%;background:#7fa8c3}
.url{margin-top:19px;color:#7b93a6;font-size:13px;letter-spacing:.3px}
.window{position:absolute;left:508px;top:64px;width:978px;overflow:hidden;border:1px solid #9ebbd14d;border-radius:12px;box-shadow:0 24px 80px #28486729,0 0 80px #3487b30b;transform:perspective(1600px) rotateY(-9deg) rotateX(1deg) rotateZ(-1.5deg);transform-origin:0 50%;background:#f3f5f8}
.window img{width:100%;height:auto;display:block}
.edge{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 1px #fff8}
.fade{position:absolute;bottom:0;left:486px;right:0;height:66px;background:linear-gradient(transparent,#eaf2f9aa)}
</style>
<div class="poster">
<svg class="facet" viewBox="0 0 1280 640" aria-hidden="true"><path fill="#5aa3d108" d="M0 0h506L234 640H0z"/><path fill="#6ec9fc08" d="M220 0h330L1280 640H804z"/><path fill="#ffffff70" d="M0 640 744 0h536v134L542 640z"/></svg>
<div class="halo"></div><div class="copy"><img class="icon" src="${logo}" alt="Javdex 图标">
<div class="brand">Jav<span>dex</span></div><h1>以番号为核心的本地媒体库</h1>
<p class="description">扫描建库 · 一键刮削 · 本地 AI 字幕</p>
<div class="platforms">Windows<b></b>macOS<b></b>Linux<span style="color:#7b93a6;margin-left:4px">/</span>NAS</div>
<div class="url">github.com/JavdexLabs/Javdex</div></div>
<div class="window"><img src="${library}" alt="Javdex 当前版本媒体库界面"><div class="edge"></div></div><div class="fade"></div></div></html>`
writeFileSync(path.join(output, 'social-preview.html'), html)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 })
  await page.setContent(html)
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())) })
  const hd = await page.screenshot({ path: path.join(output, 'social-preview@2x.png') })
  const png = await sharp(hd).resize(1280, 640).png({ palette: true, quality: 95, effort: 10 }).toBuffer()
  assert.ok(png.length < 1000000, 'GitHub social preview must be smaller than 1 MB')
  writeFileSync(path.join(images, 'social-preview.png'), png)
  const jpg = await sharp(hd).resize(1280, 640).jpeg({ quality: 95, mozjpeg: true }).toBuffer()
  writeFileSync(path.join(output, 'social-preview.jpg'), jpg)
  console.log(JSON.stringify({ png: path.join(images, 'social-preview.png'), width: 1280, height: 640, bytes: png.length, hd: path.join(output, 'social-preview@2x.png') }))
} finally { await browser.close() }
