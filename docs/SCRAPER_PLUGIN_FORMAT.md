# Scraper Plugin Format

This app supports two scraper plugin kinds:

- `video`: video metadata scraper.
- `actress`: actress profile scraper.

Custom plugins are imported as a single JSON package file. The recommended
extension is `.avscraper.json`, with a default export name like
`{plugin-name}.{kind}.avscraper.json` (for example `tokyolib.video.avscraper.json`).

Exported packages include a `kind` field (`video` or `actress`). On import, the app
uses a unified entry point and routes the plugin to the correct list from `kind`.

## Package Shape

```json
{
  "schemaVersion": 1,
  "kind": "video",
  "name": "Example Site",
  "version": "1.0.0",
  "description": "Scrapes example.com video pages",
  "author": "optional",
  "homepage": "https://example.com",
  "code": "module.exports = { async parseVideo(ctx) { return null } }"
}
```

Rules:

- `schemaVersion` must be `1`.
- `kind` must be `video` or `actress`.
- `name` must be unique and cannot reuse a built-in plugin name.
- `code` must be CommonJS JavaScript.
- Plugin code runs in a restricted worker sandbox. Do not use `require`,
  `import`, Node globals, app-internal files, or direct filesystem/network APIs.
  Use only the provided `ctx` helpers and fetch methods.

Imported plugins are stored under:

```text
app.getPath('userData')/scraper_plugins/{video|actress}/{plugin-name}/
```

## Video Plugin Contract

`code` must export:

```js
module.exports = {
  async parseVideo(ctx) {
    return null
  }
}
```

`ctx` contains:

- `ctx.code`
- `ctx.proxyUrl`
- `ctx.fetchPage(url, { readySelector, timeoutMs, settleWhenText })`
- `ctx.fetchBuffer(url)`
- `ctx.cheerio`
- `ctx.helpers.absoluteUrl(href, baseUrl)`
- `ctx.helpers.normalizeDate(text)` (returns `YYYY-MM-DD`; month-only
  source text such as `2021年10月` is normalized to `2021-10-01`)
- `ctx.helpers.normalizeText(text)`
- `ctx.helpers.unique(values)`

Return `null` or:

```js
{
  code: ctx.code,
  title: '...',
  summary: '...',
  coverUrl: 'https://...',
  releaseDate: 'YYYY-MM-DD',
  maker: '...',
  publisher: '...',
  series: '...',
  director: '...',
  durationSeconds: 120,
  sourceUrl: 'https://...',
  ratingAverage: 4.2,
  ratingCount: 100,
  sampleImageUrls: ['https://...'],
  actresses: [{ name: '...', avatarUrl: 'https://...', gender: 'female' | 'male' }],
  tags: ['...']
}
```

Date fields must be valid `YYYY-MM-DD` strings. If the source page only
provides year and month, use the first day of that month (`YYYY-MM-01`); never
return an invalid placeholder such as `YYYY-MM-00`.

Recommended detail-page entry strategies:

- Direct detail mode: use this only when the site's detail URL can be derived
  reliably from the code, or when a search-by-code URL redirects to a detail page.
- Search-to-detail mode: use this when detail URLs cannot be derived reliably.
  Fetch the search page, parse result links, choose a reliable matching result,
  then fetch and parse the detail page.

For direct detail mode, treat the page as a hit only when detail-page selectors
and the returned code/title prove it matches the requested code. If direct URLs
fail, switch to search-to-detail mode or return `null`.

For search-to-detail mode, convert the result `href` with
`ctx.helpers.absoluteUrl(href, searchUrl)`, fetch that detail URL, parse fields
from the detail page, and set `sourceUrl` to the detail URL.

The search page should be used only to locate the detail page. Do not return
metadata from a generic search results page unless the site renders the complete
detail record there.

## Actress Plugin Contract

`code` must export:

```js
module.exports = {
  async parseActress(ctx) {
    return null
  }
}
```

`ctx` contains:

- `ctx.mainName`
- `ctx.aliases`
- `ctx.proxyUrl`
- `ctx.fetchPage(url, { readySelector, timeoutMs, settleWhenText })`
- `ctx.fetchBuffer(url)`
- `ctx.cheerio`
- `ctx.helpers.absoluteUrl(href, baseUrl)`
- `ctx.helpers.normalizeDate(text)` (returns `YYYY-MM-DD`; month-only
  source text such as `2021年10月` is normalized to `2021-10-01`)
- `ctx.helpers.normalizeText(text)`
- `ctx.helpers.unique(values)`

Return `null` or:

```js
{
  mainName: ctx.mainName,
  nameZh: '...',
  nameEn: '...',
  avatarUrl: 'https://...',
  birthDate: 'YYYY-MM-DD',
  debutDate: 'YYYY-MM-DD',
  heightCm: 160,
  bustCm: 84,
  waistCm: 59,
  hipCm: 88,
  cupSize: 'E',
  bloodType: 'A',
  zodiac: 'Leo',
  nationality: 'Japan',
  profileSummary: '...',
  galleryImageUrls: ['https://...'],
  aliases: ['...']
}
```

Date fields must be valid `YYYY-MM-DD` strings. If the source page only
provides year and month, use the first day of that month (`YYYY-MM-01`); never
return an invalid placeholder such as `YYYY-MM-00`.

Recommended profile-page entry strategies:

- Direct profile mode: use this only when the site's profile URL can be derived
  reliably from the name or slug.
- Search-to-profile mode: use this when profile URLs cannot be derived reliably.
  Try `ctx.mainName`, then each `ctx.aliases` entry; fetch the search page, parse
  result links, choose a reliable matching profile, then fetch and parse it.
- Dynamic/AJAX search mode: if the visible search UI updates a result container
  without changing `location.href`, inspect the site's scripts or network-shaped
  endpoint and reproduce that endpoint with `ctx.fetchPage`. Do not treat an
  unchanged browser URL as a failed search.

For direct profile mode, treat the page as a hit only when profile selectors and
the displayed name prove it matches the requested actress. If direct URLs fail,
switch to search-to-profile mode or try the next name.

For search-to-profile mode, convert the result `href` with
`ctx.helpers.absoluteUrl(href, searchUrl)`, fetch that profile URL, and parse
fields from the profile page.

The search page should be used only to locate the profile page. If no reliable
profile link is found, try the next name or return `null`.

## UI

Settings exposes plugin management for both kinds:

- Import custom plugin package (routes by the package `kind` field).
- Export imported custom plugin package (JSON includes `kind`; default filename includes kind suffix).
- Delete imported custom plugin package.
