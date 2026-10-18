import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sections } from '../site.config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const content = path.join(root, 'website/src/content/docs');

test('every configured document exists and navigation is unique', async () => {
  const slugs = sections.flatMap(section => section.items);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of slugs) await access(path.join(content, `${slug}.md`));
});
test('legacy document indexes and contributor entry points have no broken source-file links', async () => {
  const files = ['docs/USER_GUIDE.md', 'docs/SERVER_MODE.md', 'docs/SERVER_UPDATE.md', 'docs/METATUBE_SETUP.md', 'docs/NFO_COMPATIBILITY.md', 'docs/DEVELOPMENT.md', 'README.md', 'AGENTS.md', 'website/README.md'];
  for (const file of files) {
    const body = (await readFile(path.join(root, file), 'utf8')).replace(/```[\s\S]*?```/g, '');
    for (const match of body.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:|^\//i.test(target)) continue;
      await assert.doesNotReject(access(path.resolve(root, path.dirname(file), decodeURIComponent(target))), `${file}: ${target}`);
    }
  }
});
test('public documents are explicit and do not include engineering archives', async () => {
  const entries = (await readdir(content, { recursive: true })).map(file => file.split(path.sep).join('/'));
  assert.equal(entries.some(file => /(?:^|\/)(reviews|performance|adr|archive)(?:\/|$)/.test(file)), false);
  for (const file of entries.filter(file => file.endsWith('.md'))) {
    const body = await readFile(path.join(content, file), 'utf8');
    assert.match(body, /^---\r?\ntitle: /, `Missing title: ${file}`);
    assert.doesNotMatch(body, /^import\s+\{[^}]+\}\s+from\s+['"]@astrojs\/starlight\/components['"]/m, `Raw MDX import in .md file: ${file}`);
    assert.doesNotMatch(body, /<(?:Steps|Tabs|TabItem)\b/, `Raw MDX component tag in .md file: ${file}`);
    assert.doesNotMatch(body, /SenseVoice|Sherpa-ONNX|Marian|rollback --config/, `Hallucinated technical term in: ${file}`);
  }
});

test('server instructions use the current authorization and upgrade contracts', async () => {
  const body = await readFile(path.join(content, 'server/remote-connection.md'), 'utf8');
  const commands = [...body.matchAll(/```(?:bash|sh)\r?\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
  assert.doesNotMatch(commands, /(?:index\.js|javdex-server)\s+(?:bind|recover|pair|pair-recover)\b/);
  assert.match(commands, /\/opt\/javdex-manager\/index\.js token --config/);
  assert.doesNotMatch(body, /增加独立[^\n]*更新端口|默认在线检查只读取正式 Release|提交前托管更新失败可自动恢复|自动执行停服备份/);
  const updateBody = await readFile(path.join(content, 'server/managed-updates.md'), 'utf8');
  assert.match(updateBody, /人工恢复|recoveryRequired/);
});

test('product upgrade FAQ links the single upgrade guide with the current database schema', async () => {
  const product = await readFile(path.join(root, 'website/src/components/ProductContent.html'), 'utf8');
  assert.match(product, /href="@@BASE@@operations\/upgrade-and-compatibility\/"/);
  assert.doesNotMatch(product, /schema\s*19\s*→\s*20/);
  const migrations = await readFile(path.join(root, 'packages/library/src/db/migrations.ts'), 'utf8');
  const current = /export const CURRENT_SCHEMA_VERSION = (\d+)/.exec(migrations)?.[1];
  assert.ok(current, 'the library publishes its current schema');
  const upgrade = await readFile(path.join(content, 'operations/upgrade-and-compatibility.md'), 'utf8');
  assert.match(upgrade, new RegExp(`schema 19[^\\n]*升级到 ${current}`));
});

test('legacy server authorization section points at the current server heading', async () => {
  const legacy = await readFile(path.join(root, 'docs/SERVER_MODE.md'), 'utf8');
  const serverDoc = await readFile(path.join(content, 'server/remote-connection.md'), 'utf8');
  assert.match(serverDoc, /^## 启动与设备授权$/m);
  assert.match(legacy, /server\/remote-connection\.md#启动与设备授权/);
  assert.doesNotMatch(legacy, /server\/remote-connection\.md#启动与认主/);
});

test('markdown documents have valid emphasis delimiter syntax for CommonMark', async () => {
  const files = await readdir(content, { recursive: true });
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const body = await readFile(path.join(content, file), 'utf8');
    // Ensure no un-spaced ** wrapping punctuation like **“ or ”** or ）** adjacent to CJK characters
    const badBold = body.match(/[^\s\w`*]\*\*[^\s*]+[）”]\*\*[^\s\w`*]/g);
    assert.strictEqual(badBold, null, `Found unrendered bold syntax in ${file}: ${badBold}`);
  }
});
