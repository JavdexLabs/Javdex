const SEARCH_BASE = 'https://javdb.com/search?q=';
const SITE_BASE = 'https://javdb.com';

const PANEL_LABELS = {
  code: ['番號', '番号', '品番'],
  date: ['日期', '発売日', '配信開始日'],
  duration: ['時長', '时长', '収録時間', '片長', '片长'],
  director: ['導演', '导演', '監督', '监督'],
  maker: ['片商', 'メーカー', '製作商', '制作商'],
  publisher: ['發行', '发行', '發行商', '发行商'],
  series: ['系列', 'シリーズ'],
  rating: ['評分', '评分', '評価'],
  tags: ['類別', '类别', 'ジャンル'],
  actors: ['演員', '演员', '出演者']
};

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function absoluteJavdbUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, SITE_BASE).toString();
  } catch {
    return null;
  }
}

function panelMap($detail) {
  const map = new Map();
  $detail('.panel-block').each((i, panel) => {
    const $panel = $detail(panel);
    const label = $panel.find('strong').first().text().trim().replace(/[:：]\s*$/, '');
    if (!label || map.has(label)) return;
    const $value = $panel.find('.value').first();
    map.set(label, $value.length ? $value : $panel);
  });
  return map;
}

function pickPanel(map, key) {
  for (const alias of PANEL_LABELS[key] || []) {
    const $panel = map.get(alias);
    if ($panel) return $panel;
  }
  return null;
}

function findByContent($detail, pattern) {
  return $detail('.panel-block').filter((i, panel) =>
    $detail(panel).find(pattern).length > 0
  ).first();
}

function cleanPersonName(raw) {
  return String(raw || '')
    .replace(/[（(][^（()）]*[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseActresses($detail, map) {
  let $panel = pickPanel(map, 'actors');
  if (!$panel || !$panel.find('a').length) {
    $panel = findByContent($detail, 'a[href*="/actors/"]');
  }
  if (!$panel.length) return [];

  const actresses = [];
  $panel.find('a').each((i, link) => {
    const $link = $detail(link);
    const name = cleanPersonName($link.text());
    if (!name) return;
    actresses.push({ name, gender: $link.hasClass('actor-female') ? 'female' : 'male' });
  });
  return actresses;
}

function parseTags($detail, map) {
  const $panel = pickPanel(map, 'tags') || findByContent($detail, 'a[href*="/tags/"]');
  if (!$panel.length) return [];

  if ($panel.find('a[href*="/tags/"]').length) {
    const tags = [];
    $panel.find('a[href*="/tags/"]').each((i, link) => {
      const name = $detail(link).text().trim();
      if (name) tags.push(name);
    });
    return tags;
  }

  return $panel.text().split(/[,，]/).map((raw) => raw.trim()).filter(Boolean);
}

function searchItemCode($search, item) {
  const $item = $search(item);
  const explicit = $item.find('.video-title strong').first().text().trim();
  if (explicit) return normalizeCode(explicit);
  const text = $item.find('.video-title').text().trim();
  return normalizeCode(text.split(/\s+/)[0]);
}

async function parseVideo(ctx) {
  const requestedCode = normalizeCode(ctx.code);
  const searchUrl = `${SEARCH_BASE}${encodeURIComponent(requestedCode)}&f=all`;
  const searchHtml = await ctx.fetchPage(searchUrl, { readySelector: '.movie-list' });
  const $search = ctx.cheerio.load(searchHtml);
  const detailUrls = [];

  $search('.movie-list .item').each((i, item) => {
    if (searchItemCode($search, item) !== requestedCode) return;
    const detailUrl = absoluteJavdbUrl($search(item).find('a.box[href]').first().attr('href'));
    if (detailUrl) detailUrls.push(detailUrl);
  });

  if (detailUrls.length === 0) return [];

  // Promise.all is intentional: one failed exact-match detail invalidates the whole candidate set.
  return Promise.all(detailUrls.map(async (detailUrl) => {
    const detailHtml = await ctx.fetchPage(detailUrl, { readySelector: '.movie-panel-info' });
    return parseDetail(ctx, detailHtml, detailUrl, requestedCode);
  }));
}

function parseDetail(ctx, detailHtml, detailUrl, requestedCode) {
  const $detail = ctx.cheerio.load(detailHtml);
  const map = panelMap($detail);
  const labelText = (key) => {
    const $panel = pickPanel(map, key);
    return $panel ? $panel.text().trim() : '';
  };

  const currentTitle = $detail('h2.title .current-title').first().text().trim();
  const originTitle = $detail('h2.title .origin-title').first().text().trim();
  const title = originTitle || currentTitle;
  const codePanel = pickPanel(map, 'code');
  const detailCode = normalizeCode((codePanel ? codePanel.text() : '') || requestedCode);

  const $cover = $detail('img.video-cover').first().length
    ? $detail('img.video-cover').first()
    : $detail('.video-cover').first();
  const coverUrl = $cover.attr('src') || '';

  const rawDate = labelText('date');
  const releaseDate = (ctx.helpers.normalizeDate(rawDate) || rawDate).trim();
  let durationSeconds = 0;
  const durationMatch = labelText('duration').match(/(\d+)/);
  if (durationMatch) durationSeconds = parseInt(durationMatch[1], 10) * 60;

  const maker = labelText('maker');
  const publisher = labelText('publisher');
  const series = labelText('series');
  const director = labelText('director');

  let ratingAverage = 0;
  let ratingCount = 0;
  const rawRating = labelText('rating');
  if (rawRating) {
    const avgMatch = rawRating.match(/([\d.]+)\s*分/);
    if (avgMatch) ratingAverage = parseFloat(avgMatch[1]);
    const countMatch = rawRating.match(/(\d+)\s*人/);
    if (countMatch) ratingCount = parseInt(countMatch[1], 10);
  }


  const sampleImageUrls = [];
  $detail('a[data-fancybox="gallery"]').each((i, link) => {
    const href = $detail(link).attr('href');
    if (href && !href.includes('/covers/') && !href.includes('/login')) {
      sampleImageUrls.push(href);
    }
  });

  return {
    code: detailCode,
    title,
    summary: '',
    coverUrl,
    releaseDate,
    maker,
    publisher,
    series,
    director,
    durationSeconds,
    actresses: parseActresses($detail, map),
    tags: parseTags($detail, map),
    sourceUrl: detailUrl,
    ratingAverage,
    ratingCount,
    sampleImageUrls
  };
}

module.exports = { parseVideo };
