import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { createRequire } from 'node:module';
import path from 'node:path';
import { site, sections, sitePath } from './site.config.mjs';

const require = createRequire(import.meta.url);
const astroCookie = require.resolve('cookie', { paths: [path.dirname(require.resolve('astro/package.json'))] });

export default defineConfig({
  site: site.origin,
  base: site.base,
  trailingSlash: 'always',
  outDir: '../dist-pages',
  // Keep Astro's Cookie 2 implementation local to its prerender bundle.
  // The application separately uses Cookie 0.x/1.x; bare external imports
  // from .astro/.prerender would otherwise resolve the workspace root copy.
  vite: { resolve: { alias: [{ find: /^cookie$/, replacement: astroCookie }] } },
  integrations: [starlight({
    title: 'Javdex',
    description: 'Javdex 使用文档：从本机媒体库开始，到服务端部署与维护。',
    defaultLocale: 'root',
    locales: { root: { label: '简体中文', lang: 'zh-CN' } },
    logo: { src: './assets/icon.png' },
    favicon: '/assets/icon.png',
    head: [{ tag: 'meta', attrs: { property: 'og:image', content: `${site.origin}${sitePath('assets/screenshots/library.webp')}` } }],
    social: [{ icon: 'github', label: 'GitHub', href: `https://github.com/${site.repository}` }],
    editLink: { baseUrl: `https://github.com/${site.repository}/edit/main/website/` },
    customCss: ['./src/styles/theme.css'],
    components: {
      Header: './src/components/Header.astro',
      PageTitle: './src/components/PageTitle.astro',
      Footer: './src/components/Footer.astro',
      Head: './src/components/Head.astro',
      ThemeSelect: './src/components/ThemeSelect.astro',
    },
    sidebar: sections.map(section => ({ label: section.label, collapsed: true, items: section.items.map(slug => ({ slug: slug.replace(/\/index$/, ''), attrs: { draggable: false } })) })),
    lastUpdated: false,
    credits: true,
    expressiveCode: { themes: ['github-light', 'github-dark'] },
  })],
});
