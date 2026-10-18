import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { site } from '../site.config.mjs';

const directory = path.resolve(fileURLToPath(new URL('../../dist-pages/', import.meta.url)));
const entries = (await readdir(directory, { recursive: true })).map(file => file.split(path.sep).join('/'));
const pages = entries.filter(file => file.endsWith('.html'));
const documents = new Map();
for (const file of pages) {
  const html = await readFile(path.join(directory, file), 'utf8');
  documents.set(file, { html, ids: new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])) });
}
const errors = [];
let checked = 0;
for (const [file, { html }] of documents) {
  for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = match[1].replaceAll('&amp;', '&');
    if (!raw || /^(data:|mailto:|tel:|javascript:)/.test(raw)) continue;
    const url = new URL(raw, `${site.origin}${site.base}${file}`);
    if (url.origin !== site.origin) continue;
    if (!url.pathname.startsWith(site.base)) { errors.push(`${file}: URL escapes site base: ${raw}`); continue; }
    let target = decodeURIComponent(url.pathname.slice(site.base.length)) || 'index.html';
    if (file === '404.html' && target === '404/') target = '404.html';
    if (target.endsWith('/')) target += 'index.html';
    const resolved = path.resolve(directory, target);
    if (!resolved.startsWith(`${directory}${path.sep}`)) { errors.push(`${file}: unsafe path ${raw}`); continue; }
    try {
      const info = await stat(resolved);
      if (!info.isFile()) throw new Error('not a file');
      if (url.hash && target.endsWith('.html') && !documents.get(target)?.ids.has(decodeURIComponent(url.hash.slice(1)))) errors.push(`${file}: missing anchor ${raw}`);
      checked++;
    } catch { errors.push(`${file}: missing file ${raw}`); }
  }
  if (file !== '404.html' && !/<link[^>]+rel="canonical"/.test(html)) errors.push(`${file}: missing canonical`);
  if (!/<html[^>]+lang="zh-CN"/.test(html)) errors.push(`${file}: incorrect document language`);
}
for (const route of ['index.html', 'product/index.html', 'download/index.html', 'getting-started/overview/index.html', 'server/deploy/index.html', 'guides/ai-subtitles-and-models/index.html']) assert.ok(documents.has(route), `Missing route: ${route}`);
assert.ok(entries.includes('pagefind/pagefind.js'), 'Pagefind index must be generated');
assert.ok(entries.includes('sitemap-index.xml'), 'Sitemap must be generated');
assert.ok(entries.includes('.nojekyll'), 'Pages must retain its static-site marker');
assert.equal(entries.some(file => /(?:^|\/)(reviews|performance|adr|archive)\//.test(file)), false, 'Engineering archives must not be published');
assert.equal(errors.length, 0, errors.join('\n'));
console.log(`Website check passed: ${pages.length} pages, ${checked} local references, Chinese language, Pagefind, sitemap and curated content.`);
