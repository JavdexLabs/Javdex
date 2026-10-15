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
  }
});

test('server developer instructions use the current authorization and upgrade contracts', async () => {
  const body = await readFile(path.join(content, 'developers/server.md'), 'utf8');
  const commands = [...body.matchAll(/```(?:bash|sh)\r?\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
  assert.doesNotMatch(commands, /(?:index\.js|javdex-server)\s+(?:bind|recover|pair|pair-recover)\b/);
  assert.match(commands, /\/opt\/javdex-manager\/index\.js token --config/);
  assert.doesNotMatch(body, /增加独立[^\n]*更新端口|默认在线检查只读取正式 Release|提交前托管更新失败可自动恢复|自动执行停服备份/);
  assert.match(body, /安装[\s\S]*人工恢复/);
});
