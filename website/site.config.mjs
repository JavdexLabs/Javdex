export const site = {
  origin: 'https://javdexlabs.github.io',
  base: '/Javdex/',
  repository: 'JavdexLabs/Javdex',
  contentVersion: '0.9.0-beta.5',
};

export function sitePath(value = '') {
  return `${site.base}${value.replace(/^\/+/, '')}`;
}

export const sections = [
  { label: '开始使用', items: ['start/index', 'start/install', 'start/connection', 'start/library'] },
  { label: '使用指南', items: ['guide/index', 'guide/scraping', 'guide/ai-services', 'guide/playlists', 'guide/playback', 'guide/subtitles', 'guide/local-models', 'guide/pending', 'guide/nfo', 'guide/backup', 'guide/appearance', 'guide/web'] },
  { label: '服务端', items: ['server/index', 'server/deploy', 'server/adoption', 'server/pairing', 'server/update', 'server/recovery'] },
  { label: '参考资料', items: ['reference/index', 'reference/metatube', 'reference/nfo', 'reference/data', 'reference/server'] },
  { label: '开发与扩展', items: ['developers/index', 'developers/plugins', 'developers/server', 'developers/releases'] },
  { label: '版本与帮助', items: ['releases/index', 'releases/upgrade', 'help/index'] },
];

export const legacyHashes = {
  download: 'download/',
  product: 'product/#product',
  workflow: 'product/#workflow',
  nfo: 'product/#nfo',
};
