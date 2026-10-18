export const site = {
  origin: 'https://javdexlabs.github.io',
  base: '/Javdex/',
  repository: 'JavdexLabs/Javdex',
  contentVersion: '0.9.0',
};

export function sitePath(value = '') {
  return `${site.base}${value.replace(/^\/+/, '')}`;
}

export const sections = [
  {
    label: '开始使用',
    items: [
      'getting-started/overview',
      'getting-started/choose-mode',
      'getting-started/installation',
      'getting-started/quickstart',
    ],
  },
  {
    label: '核心指南',
    items: [
      'guides/library-and-scanning',
      'guides/pending-and-curation',
      'guides/metadata-scraping',
      'guides/nfo-migration-and-export',
      'guides/actresses-and-facets',
      'guides/playlists-and-ai-curation',
      'guides/playback',
      'guides/ai-subtitles-and-models',
      'guides/lan-web-access',
      'guides/privacy-and-storage',
    ],
  },
  {
    label: 'NAS 与服务端',
    items: [
      'server/deploy',
      'server/remote-connection',
      'server/managed-updates',
    ],
  },
  {
    label: '运维与速查',
    items: [
      'operations/backup-and-migration',
      'operations/upgrade-and-compatibility',
      'operations/configuration-reference',
      'operations/shortcuts-reference',
      'operations/troubleshooting',
    ],
  },
  {
    label: '插件与开发',
    items: [
      'plugins/overview-and-agent',
      'plugins/contributing-and-build',
    ],
  },
];

export const legacyHashes = {
  download: 'download/',
  product: 'product/#product',
  workflow: 'product/#workflow',
  nfo: 'product/#nfo',
};
