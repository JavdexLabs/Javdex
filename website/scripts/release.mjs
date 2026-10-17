import { site } from '../site.config.mjs';

export const releaseUrl = `https://github.com/${site.repository}/releases/latest`;
export const desktopMatchers = {
  windowsX64: /^Javdex-Setup-(.+)-x64\.exe$/i,
  windowsZip: /^(?:Javdex-Setup-(.+)-x64|Javdex[ -](.+)-win)\.zip$/i,
  macArm64: /^Javdex-(.+)-arm64\.dmg$/i,
  macX64: /^Javdex-(.+)-x64\.dmg$/i,
  linuxAppImage: /^Javdex-(.+)-x86_64\.AppImage$/i,
  linuxDeb: /^Javdex-(.+)-amd64\.deb$/i,
};

export function fallbackManifest() {
  return { schemaVersion: 1, version: '最新正式版', releaseUrl, publishedAt: null, downloads: {}, extras: {}, available: false };
}

export function createReleaseManifest(release) {
  if (release.prerelease || release.draft || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) {
    throw new Error('The website requires a published stable Release');
  }
  const version = release.tag_name.replace(/^v/, '');
  const matchers = {
    ...desktopMatchers,
    serverAmd64: new RegExp(`^Javdex-server-${version.replaceAll('.', '\\.')}\\-linux-amd64\\.javdex-update$`, 'i'),
    serverArm64: new RegExp(`^Javdex-server-${version.replaceAll('.', '\\.')}\\-linux-arm64\\.javdex-update$`, 'i'),
    playbackSources: new RegExp(`^Javdex-Playback-Sources-${version.replaceAll('.', '\\.')}\\.tar\\.gz$`, 'i'),
    checksums: /^SHA256SUMS\.txt$/,
  };
  const downloads = {};
  const extras = {};
  for (const [key, matcher] of Object.entries(matchers)) {
    const candidates = (release.assets ?? []).filter(asset => matcher.test(asset.name));
    if (candidates.length > 1) throw new Error(`Ambiguous Release asset: ${key}`);
    if (!candidates.length) continue;
    const asset = candidates[0];
    if (key in desktopMatchers && !matcher.exec(asset.name).slice(1).includes(version)) {
      throw new Error(`Release asset version mismatch: ${key}`);
    }
    if (!Number.isFinite(asset.size) || asset.size <= 0) throw new Error(`Invalid Release asset size: ${key}`);
    const url = new URL(asset.browser_download_url);
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${site.repository}/releases/download/${release.tag_name}/`)) {
      throw new Error(`Invalid Release asset URL: ${key}`);
    }
    const target = key in desktopMatchers ? downloads : extras;
    target[key] = { name: asset.name, url: url.href, size: asset.size, contentType: asset.content_type };
  }
  const [major, minor] = version.split('.').map(Number);
  const required = [...Object.keys(desktopMatchers), ...(major > 0 || minor >= 9 ? ['serverAmd64', 'serverArm64', 'playbackSources', 'checksums'] : [])];
  const missing = required.filter(key => !downloads[key] && !extras[key]);
  if (missing.length) throw new Error(`Latest release is missing required downloads: ${missing.join(', ')}`);
  return { schemaVersion: 1, version: release.tag_name, releaseUrl: `https://github.com/${site.repository}/releases/tag/${release.tag_name}`, publishedAt: release.published_at, downloads, extras, available: true };
}

export async function resolveReleaseManifest({ offline = false, strict = process.env.CI === 'true', fetcher = fetch } = {}) {
  if (offline) return fallbackManifest();
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Javdex-Pages-Builder', 'X-GitHub-Api-Version': '2022-11-28' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetcher(`https://api.github.com/repos/${site.repository}/releases/latest`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub Release API returned HTTP ${response.status}`);
    return createReleaseManifest(await response.json());
  } catch (error) {
    if (strict) throw error;
    console.warn(`Release manifest fallback: ${error.message}`);
    return fallbackManifest();
  }
}
