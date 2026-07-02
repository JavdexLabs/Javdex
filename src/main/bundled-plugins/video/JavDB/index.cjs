async function parseVideo(ctx) {
  const code = ctx.code.toUpperCase();
  const searchUrl = `https://javdb.com/search?q=${encodeURIComponent(code)}&f=all`;

  // Step 1: Search for the video
  const searchHtml = await ctx.fetchPage(searchUrl, { readySelector: '.movie-list' });
  const $search = ctx.cheerio.load(searchHtml);

  // Find the detail link that matches our code
  let detailUrl = null;
  const items = $search('.movie-list .item');
  items.each((i, item) => {
    const $item = $search(item);
    const titleText = $item.find('.video-title').text().trim().toUpperCase();
    if (titleText.includes(code)) {
      const link = $item.find('a.box');
      if (link.length) {
        detailUrl = 'https://javdb.com' + link.attr('href');
      }
    }
  });

  if (!detailUrl) {
    // Try direct match by checking all items
    const firstItem = $search('.movie-list .item').first();
    const link = firstItem.find('a.box');
    if (link.length) {
      detailUrl = 'https://javdb.com' + link.attr('href');
    }
  }

  if (!detailUrl) {
    return null;
  }

  // Step 2: Fetch detail page
  const detailHtml = await ctx.fetchPage(detailUrl, { readySelector: '.video-detail' });
  const $detail = ctx.cheerio.load(detailHtml);

  // Parse metadata panels
  const metadata = {};
  $detail('.video-detail .panel-block').each((i, panel) => {
    const $panel = $detail(panel);
    const label = $panel.find('strong').text().trim().replace(':', '');
    const value = $panel.find('.value').text().trim();
    metadata[label] = value;
  });

  // Parse title
  let title = '';
  const currentTitle = $detail('.video-detail h2.title .current-title').text().trim();
  const originTitle = $detail('.video-detail h2.title .origin-title').text().trim();
  title = originTitle || currentTitle;

  // Parse cover
  let coverUrl = '';
  const coverImg = $detail('.video-detail .video-cover');
  if (coverImg.length) {
    coverUrl = coverImg.attr('src');
  }

  // Parse release date
  let releaseDate = '';
  if (metadata['日期']) {
    releaseDate = metadata['日期'].trim();
  }

  // Parse duration
  let durationSeconds = 0;
  if (metadata['時長']) {
    const durationMatch = metadata['時長'].match(/(\d+)/);
    if (durationMatch) {
      durationSeconds = parseInt(durationMatch[1]) * 60;
    }
  }

  // Parse maker (片商)
  let maker = '';
  if (metadata['片商']) {
    maker = metadata['片商'].trim();
  }

  // Parse publisher (發行)
  let publisher = '';
  if (metadata['發行']) {
    publisher = metadata['發行'].trim();
  }

  // Parse series (系列)
  let series = '';
  if (metadata['系列']) {
    series = metadata['系列'].trim();
  }

  // Parse director (導演)
  let director = '';
  if (metadata['導演']) {
    director = metadata['導演'].trim();
  }

  // Parse rating
  let ratingAverage = 0;
  let ratingCount = 0;
  if (metadata['評分']) {
    const ratingText = metadata['評分'];
    const avgMatch = ratingText.match(/([\d.]+)分/);
    if (avgMatch) {
      ratingAverage = parseFloat(avgMatch[1]);
    }
    const countMatch = ratingText.match(/由(\d+)人評價/);
    if (countMatch) {
      ratingCount = parseInt(countMatch[1]);
    }
  }

  // Parse tags (類別)
  const tags = [];
  if (metadata['類別']) {
    const tagText = metadata['類別'];
    tagText.split(',').forEach(t => {
      const tag = t.trim();
      if (tag) tags.push(tag);
    });
  }

  // Parse actresses (演員) - use DOM structure for gender symbols
  const actresses = [];
  const actorPanel = $detail('.panel-block').filter((i, p) => {
    return $detail(p).find('strong').text().trim().includes('演員');
  });
  if (actorPanel.length) {
    const valueDiv = actorPanel.find('.value');
    // Each actor is: <a>name</a><strong class="symbol female">♀</strong> or <strong class="symbol male">♂</strong>
    valueDiv.contents().each((i, node) => {
      if (node.type === 'tag' && node.name === 'a') {
        const $a = $detail(node);
        const name = $a.text().trim();
        if (name) {
          // Check next sibling for gender symbol
          const next = $detail(node).next();
          let gender = undefined;
          if (next.length && next.is('strong.symbol')) {
            const symbol = next.text().trim();
            if (symbol === '♀') gender = 'female';
            else if (symbol === '♂') gender = 'male';
          }
          actresses.push({ name, gender });
        }
      }
    });
  }

  // Parse sample images
  const sampleImageUrls = [];
  $detail('a[data-fancybox="gallery"]').each((i, link) => {
    const href = $detail(link).attr('href');
    if (href && !href.includes('/covers/') && !href.includes('/login')) {
      sampleImageUrls.push(href);
    }
  });

  // Parse summary (not available on JavDB, leave empty)
  const summary = '';

  return {
    code,
    title,
    summary,
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