function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function absoluteJavdbUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, 'https://javdb.com').toString();
  } catch {
    return null;
  }
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
  const searchUrl = `https://javdb.com/search?q=${encodeURIComponent(requestedCode)}&f=all`;
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
    const detailHtml = await ctx.fetchPage(detailUrl, { readySelector: '.video-detail' });
    return parseDetail(ctx, detailHtml, detailUrl, requestedCode);
  }));
}

function parseDetail(ctx, detailHtml, detailUrl, requestedCode) {
  const $detail = ctx.cheerio.load(detailHtml);
  const metadata = {};
  $detail('.video-detail .panel-block').each((i, panel) => {
    const $panel = $detail(panel);
    const label = $panel.find('strong').first().text().trim().replace(/[:：]$/, '');
    const value = $panel.find('.value').text().trim();
    metadata[label] = value;
  });

  const currentTitle = $detail('.video-detail h2.title .current-title').text().trim();
  const originTitle = $detail('.video-detail h2.title .origin-title').text().trim();
  const title = originTitle || currentTitle;
  const detailCode = normalizeCode(metadata['番號'] || metadata['番号'] || requestedCode);

  let coverUrl = '';
  const coverImg = $detail('.video-detail .video-cover');
  if (coverImg.length) coverUrl = coverImg.attr('src');

  const releaseDate = (metadata['日期'] || '').trim();
  let durationSeconds = 0;
  if (metadata['時長']) {
    const durationMatch = metadata['時長'].match(/(\d+)/);
    if (durationMatch) durationSeconds = parseInt(durationMatch[1]) * 60;
  }

  const maker = (metadata['片商'] || '').trim();
  const publisher = (metadata['發行'] || '').trim();
  const series = (metadata['系列'] || '').trim();
  const director = (metadata['導演'] || '').trim();

  let ratingAverage = 0;
  let ratingCount = 0;
  if (metadata['評分']) {
    const avgMatch = metadata['評分'].match(/([\d.]+)分/);
    if (avgMatch) ratingAverage = parseFloat(avgMatch[1]);
    const countMatch = metadata['評分'].match(/由(\d+)人評價/);
    if (countMatch) ratingCount = parseInt(countMatch[1]);
  }

  const tags = [];
  if (metadata['類別']) {
    metadata['類別'].split(',').forEach((raw) => {
      const tag = raw.trim();
      if (tag) tags.push(tag);
    });
  }

  const actresses = [];
  const actorPanel = $detail('.panel-block').filter((i, panel) =>
    $detail(panel).find('strong').first().text().trim().includes('演員')
  );
  if (actorPanel.length) {
    actorPanel.find('.value').contents().each((i, node) => {
      if (node.type !== 'tag' || node.name !== 'a') return;
      const name = $detail(node).text().trim();
      if (!name) return;
      const next = $detail(node).next();
      let gender;
      if (next.length && next.is('strong.symbol')) {
        const symbol = next.text().trim();
        if (symbol === '♀') gender = 'female';
        else if (symbol === '♂') gender = 'male';
      }
      actresses.push({ name, gender });
    });
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
    actresses,
    tags,
    sourceUrl: detailUrl,
    ratingAverage,
    ratingCount,
    sampleImageUrls
  };
}

module.exports = { parseVideo };
