function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function absoluteJavlibraryUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

function detailPageCode($) {
  const explicit = $('#video_id .text').first().text().trim();
  if (explicit) return normalizeCode(explicit);
  const title = $('#video_title .post-title.text').text().trim();
  return normalizeCode(title.split(/\s+/)[0]);
}

function detailPageUrl($, baseUrl, fallbackUrl) {
  const href = $('#video_title a[href]').first().attr('href');
  return absoluteJavlibraryUrl(href, baseUrl) || fallbackUrl;
}

async function parseVideo(ctx) {
  const requestedCode = normalizeCode(ctx.code);
  const baseUrl = 'https://www.javlibrary.com/cn';
  const searchUrl = `${baseUrl}/vl_searchbyid.php?keyword=${encodeURIComponent(requestedCode)}`;
  const searchHtml = await ctx.fetchPage(searchUrl, { timeoutMs: 15000 });
  const $search = ctx.cheerio.load(searchHtml);

  if ($search('#video_info').length > 0) {
    const actualCode = detailPageCode($search);
    if (actualCode !== requestedCode) return [];
    return [
      parseDetail(
        $search,
        actualCode,
        detailPageUrl($search, baseUrl, searchUrl)
      )
    ];
  }

  const detailUrls = [];
  $search('.video').each((i, item) => {
    const $item = $search(item);
    if (normalizeCode($item.find('.id').first().text()) !== requestedCode) return;
    const href = $item.find('a[href]').first().attr('href');
    const detailUrl = absoluteJavlibraryUrl(href, baseUrl);
    if (detailUrl) detailUrls.push(detailUrl);
  });
  if (detailUrls.length === 0) return [];

  // Fetch every first-page exact match. Any rejection aborts the complete candidate set.
  return Promise.all(detailUrls.map(async (detailUrl) => {
    const detailHtml = await ctx.fetchPage(detailUrl, { timeoutMs: 15000 });
    const $detail = ctx.cheerio.load(detailHtml);
    return parseDetail($detail, detailPageCode($detail), detailUrl);
  }));
}

function parseDetail($, code, sourceUrl) {
  const result = {
    code,
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
    sourceUrl,
    ratingAverage: null,
    ratingCount: null,
    sampleImageUrls: []
  };

  const fullTitle = $('#video_title .post-title.text').text().trim();
  result.title = normalizeCode(fullTitle.slice(0, code.length)) === code
    ? fullTitle.slice(code.length).trim()
    : fullTitle;

  const coverImg = $('#video_jacket_img');
  if (coverImg.length > 0) result.coverUrl = coverImg.attr('src');

  const dateText = $('#video_date .text').text().trim();
  if (dateText) result.releaseDate = dateText;

  const durationMatch = $('#video_length .text').text().trim().match(/(\d+)/);
  if (durationMatch) result.durationSeconds = parseInt(durationMatch[1]) * 60;

  const director = $('#video_director .director a').first().text().trim();
  if (director) result.director = director;
  const maker = $('#video_maker .maker a').first().text().trim();
  if (maker) result.maker = maker;
  const publisher = $('#video_label .label a').first().text().trim();
  if (publisher) result.publisher = publisher;

  $('#video_genres .genre a').each((i, element) => {
    const tag = $(element).text().trim();
    if (tag) result.tags.push(tag);
  });
  $('#video_cast .cast .star a').each((i, element) => {
    const name = $(element).text().trim();
    if (name) result.actresses.push({ name, gender: 'female' });
  });

  const scoreMatch = $('#video_review .score').text().trim().match(/\(?([\d.]+)\)?/);
  if (scoreMatch) {
    const fivePointScore = Math.round((parseFloat(scoreMatch[1]) / 2) * 10) / 10;
    if (fivePointScore > 0 && fivePointScore <= 5) result.ratingAverage = fivePointScore;
  }

  $('.previewthumbs a').each((i, element) => {
    const href = $(element).attr('href');
    if (href) result.sampleImageUrls.push(href);
  });

  return result;
}

module.exports = { parseVideo };
