async function parseVideo(ctx) {
  const code = ctx.code.toUpperCase();
  const baseUrl = 'https://www.javlibrary.com/cn';
  const searchUrl = `${baseUrl}/vl_searchbyid.php?keyword=${encodeURIComponent(code)}`;

  // Step 1: Search
  const searchHtml = await ctx.fetchPage(searchUrl, { timeoutMs: 15000 });
  const $search = ctx.cheerio.load(searchHtml);

  // Check if we're on a detail page or search results page
  const detailUrl = getDetailUrl($search, searchHtml, baseUrl, code);

  let detailHtml;
  let finalUrl;

  if (detailUrl) {
    // We need to fetch the detail page
    detailHtml = await ctx.fetchPage(detailUrl, { timeoutMs: 15000 });
    finalUrl = detailUrl;
  } else {
    // Already on the detail page (search redirected directly)
    detailHtml = searchHtml;
    finalUrl = null;
  }

  const $ = ctx.cheerio.load(detailHtml);

  // Parse all fields
  const result = parseDetail($, code, detailHtml, finalUrl);
  return result;
}

/**
 * Extract the detail page URL from search results or direct detail page
 */
function getDetailUrl($search, searchHtml, baseUrl, code) {
  // Case 1: Already on detail page (has video_info)
  if ($search('#video_info').length > 0) {
    return null; // Already fetched the detail page
  }

  // Case 2: Search results page - find the matching video link
  // Look for video with matching ID in the search results
  const videoLinks = $search('.video a[href]');
  let bestMatch = null;

  videoLinks.each((i, el) => {
    const $el = $search(el);
    const href = $el.attr('href');
    const title = $el.attr('title') || '';
    const idText = $el.find('.id').text().trim().toUpperCase();

    if (idText === code || title.toUpperCase().includes(code)) {
      bestMatch = href;
      return false; // break
    }
  });

  if (bestMatch) {
    // Handle relative URL
    if (bestMatch.startsWith('./')) {
      return `${baseUrl}/${bestMatch.slice(2)}`;
    }
    if (bestMatch.startsWith('/')) {
      return `https://www.javlibrary.com${bestMatch}`;
    }
    return bestMatch;
  }

  // Fallback: try to find any video link
  const firstLink = $search('.video a[href]').first();
  if (firstLink.length > 0) {
    let href = firstLink.attr('href');
    if (href.startsWith('./')) {
      return `${baseUrl}/${href.slice(2)}`;
    }
    if (href.startsWith('/')) {
      return `https://www.javlibrary.com${href}`;
    }
    return href;
  }

  throw new Error(`No results found for code: ${code}`);
}

/**
 * Parse all fields from the detail page
 */
function parseDetail($, code, html, sourceUrl) {
  const result = {
    code: code,
    title: null,
    summary: null,
    coverUrl: null,
    releaseDate: null,
    maker: null,
    publisher: null,
    series: null,
    director: null,
    durationSeconds: null,
    actresses: [],
    tags: [],
    sourceUrl: sourceUrl || null,
    ratingAverage: null,
    ratingCount: null,
    sampleImageUrls: []
  };

  // --- Title ---
  const titleEl = $('#video_title .post-title.text');
  if (titleEl.length > 0) {
    const fullTitle = titleEl.text().trim();
    // Title format: "CODE title" - remove the code prefix
    const titleMatch = fullTitle.match(/^[A-Z0-9]+-[0-9]+\s+(.+)/);
    if (titleMatch) {
      result.title = titleMatch[1].trim();
    } else {
      result.title = fullTitle;
    }
  }

  // --- Cover ---
  const coverImg = $('#video_jacket_img');
  if (coverImg.length > 0) {
    result.coverUrl = coverImg.attr('src');
  }

  // --- Release Date ---
  const dateText = $('#video_date .text').text().trim();
  if (dateText) {
    result.releaseDate = dateText; // Already in YYYY-MM-DD format
  }

  // --- Duration ---
  const durationText = $('#video_length .text').text().trim();
  if (durationText) {
    const durationMatch = durationText.match(/(\d+)/);
    if (durationMatch) {
      result.durationSeconds = parseInt(durationMatch[1]) * 60;
    }
  }

  // --- Director ---
  const directorEl = $('#video_director .director a');
  if (directorEl.length > 0) {
    result.director = directorEl.text().trim();
  }

  // --- Maker (制作商) ---
  const makerEl = $('#video_maker .maker a');
  if (makerEl.length > 0) {
    result.maker = makerEl.text().trim();
  }

  // --- Publisher (发行商) ---
  const labelEl = $('#video_label .label a');
  if (labelEl.length > 0) {
    result.publisher = labelEl.text().trim();
  }

  // --- Series ---
  // JavLibrary does not have a series field in its template
  // result.series remains null

  // --- Tags (类别) ---
  const genreEls = $('#video_genres .genre a');
  if (genreEls.length > 0) {
    genreEls.each((i, el) => {
      const tag = $(el).text().trim();
      if (tag) {
        result.tags.push(tag);
      }
    });
  }

  // --- Actresses ---
  const castEls = $('#video_cast .cast .star a');
  if (castEls.length > 0) {
    castEls.each((i, el) => {
      const name = $(el).text().trim();
      if (name) {
        result.actresses.push({ name: name, gender: 'female' });
      }
    });
  }

  // --- Rating ---
  const scoreEl = $('#video_review .score');
  if (scoreEl.length > 0) {
    const scoreText = scoreEl.text().trim();
    const scoreMatch = scoreText.match(/\(?([\d.]+)\)?/);
    if (scoreMatch) {
      // Parse as float to preserve decimal precision
      result.ratingAverage = parseFloat(scoreMatch[1]);
    }
  }

  // --- Sample Images ---
  const sampleLinks = $('.previewthumbs a');
  if (sampleLinks.length > 0) {
    sampleLinks.each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        result.sampleImageUrls.push(href);
      }
    });
  }

  // --- Source URL ---
  if (!result.sourceUrl) {
    // Try to get current page URL from the title link
    const pageLink = $('#video_title a[href]');
    if (pageLink.length > 0) {
      let href = pageLink.attr('href');
      if (href && !href.startsWith('http')) {
        if (href.startsWith('/')) {
          href = `https://www.javlibrary.com${href}`;
        } else {
          href = `https://www.javlibrary.com/cn/${href.replace(/^\.\//, '')}`;
        }
      }
      result.sourceUrl = href;
    }
  }

  return result;
}

module.exports = { parseVideo };