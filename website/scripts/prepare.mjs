import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleaseManifest } from './release.mjs';

export const websiteDirectory = fileURLToPath(new URL('../', import.meta.url));

export async function prepare({ offline = false } = {}) {
  const manifest = await resolveReleaseManifest({ offline });
  const publicDirectory = path.join(websiteDirectory, 'public');
  await mkdir(path.join(websiteDirectory, '.generated'), { recursive: true });
  // This ignored directory is generated only from the curated source assets.
  await rm(path.join(publicDirectory, 'assets'), { recursive: true, force: true });
  await mkdir(path.join(publicDirectory, 'assets'), { recursive: true });
  for (const file of ['icon.png', 'LUCIDE-LICENSE.txt', 'screenshots', 'platforms']) {
    await cp(path.join(websiteDirectory, 'assets', file), path.join(publicDirectory, 'assets', file), { recursive: true });
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(websiteDirectory, '.generated/release.json'), json);
  await writeFile(path.join(publicDirectory, 'release.json'), json);
  await writeFile(path.join(publicDirectory, '.nojekyll'), '');
  console.log(`Website Release manifest: ${manifest.version} (${Object.keys(manifest.downloads).length} desktop downloads)`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepare({ offline: process.argv.includes('--offline') });
}
