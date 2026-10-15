import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseManifest, fallbackManifest, resolveReleaseManifest } from './release.mjs';
import { site, sitePath, legacyHashes } from '../site.config.mjs';

function fixture(version = '0.9.0') {
  const names = [`Javdex-Setup-${version}-x64.exe`, `Javdex-Setup-${version}-x64.zip`, `Javdex-${version}-arm64.dmg`, `Javdex-${version}-x64.dmg`, `Javdex-${version}-x86_64.AppImage`, `Javdex-${version}-amd64.deb`];
  if (version !== '0.8.0') names.push(`Javdex-server-${version}-linux-amd64.javdex-update`, `Javdex-server-${version}-linux-arm64.javdex-update`, `Javdex-Playback-Sources-${version}.tar.gz`, 'SHA256SUMS.txt');
  return { tag_name: `v${version}`, prerelease: false, draft: false, published_at: '2026-10-15T00:00:00Z', assets: names.map(name => ({ name, size: 1000, browser_download_url: `https://github.com/${site.repository}/releases/download/v${version}/${name}`, content_type: 'application/octet-stream' })) };
}

test('published stable manifest supplies six installers and four optional metadata entries', () => {
  const result = createReleaseManifest(fixture());
  assert.equal(result.schemaVersion, 1);
  assert.equal(Object.keys(result.downloads).length, 6);
  assert.equal(Object.keys(result.extras).length, 4);
  assert.equal(result.version, 'v0.9.0');
  assert.equal(result.available, true);
});
test('historical stable version remains downloadable without inventing new update files', () => {
  const result = createReleaseManifest(fixture('0.8.0'));
  assert.equal(Object.keys(result.downloads).length, 6);
  assert.deepEqual(result.extras, {});
});
test('drafts, prereleases and a beta suffix cannot become stable downloads', () => {
  assert.throws(() => createReleaseManifest({ ...fixture(), prerelease: true }), /stable/);
  assert.throws(() => createReleaseManifest({ ...fixture(), draft: true }), /stable/);
  assert.throws(() => createReleaseManifest(fixture('0.9.0-beta.3')), /stable/);
});
test('missing installer or new stable update materials fail instead of silently dropping downloads', () => {
  const value = fixture(); value.assets.pop();
  assert.throws(() => createReleaseManifest(value), /checksums/);
  value.assets.shift();
  assert.throws(() => createReleaseManifest(value), /windowsX64/);
});
test('ambiguous and off-repository assets are rejected', () => {
  const value = fixture(); value.assets.push(value.assets[0]);
  assert.throws(() => createReleaseManifest(value), /Ambiguous/);
  value.assets.pop(); value.assets[0].browser_download_url = 'https://example.com/malicious.exe';
  assert.throws(() => createReleaseManifest(value), /Invalid Release/);
});
test('offline mode has no fabricated version, date, URL or install assets', async () => {
  const result = await resolveReleaseManifest({ offline: true, fetcher: () => { throw new Error('must not request'); } });
  assert.deepEqual(result, fallbackManifest());
  assert.equal(result.publishedAt, null);
  assert.equal(result.available, false);
});
test('a desktop filename from another version cannot satisfy the current Release', () => {
  const value = fixture(); value.assets[0].name = 'Javdex-Setup-0.8.0-x64.exe';
  assert.throws(() => createReleaseManifest(value), /version mismatch/);
});
test('empty or invalid asset sizes are rejected', () => {
  const value = fixture(); value.assets[0].size = 0;
  assert.throws(() => createReleaseManifest(value), /Invalid Release asset size/);
});
test('CI errors propagate; local network failure may use explicit fallback', async () => {
  const fetcher = async () => ({ ok: false, status: 503 });
  await assert.rejects(resolveReleaseManifest({ strict: true, fetcher }), /HTTP 503/);
  assert.equal((await resolveReleaseManifest({ strict: false, fetcher })).available, false);
});
test('all legacy hash targets stay within the project base', () => {
  assert.equal(sitePath('/download/'), '/Javdex/download/');
  assert.equal(sitePath(), '/Javdex/');
  for (const target of Object.values(legacyHashes)) assert.ok(sitePath(target).startsWith('/Javdex/'));
});
