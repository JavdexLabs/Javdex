// JAV8 (AV掌上夜店) 刮削插件
// 支持字段：title, summary, cover, releaseDate, maker, publisher, series, director, actressesFemale, tags, source, samples

async function parseVideo(ctx) {
  const code = ctx.code.toUpperCase();
  
  // Step 1: Search for the video
  const searchUrl = `https://jav8.me/search?type=id&q=${encodeURIComponent(code)}`;
  const searchHtml = await ctx.fetchPage(searchUrl, { timeoutMs: 15000 });
  const $ = ctx.cheerio.load(searchHtml);
  
  // Find the video link in search results
  let detailUrl = null;
  
  // Search results have .work a.work links
  $('a.work').each((i, el) => {
    const href = $(el).attr('href');
    if (href && href.startsWith('/v/')) {
      detailUrl = `https://jav8.me${href}`;
      return false;
    }
  });
  
  if (!detailUrl) {
    // Try direct URL pattern as fallback
    detailUrl = `https://jav8.me/v/${code}`;
  }
  
  // Step 2: Fetch detail page
  const detailHtml = await ctx.fetchPage(detailUrl, { timeoutMs: 15000 });
  const $d = ctx.cheerio.load(detailHtml);
  
  // Title
  let title = '';
  const titleEl = $d('h1.title.is-size-5.text-jp');
  if (titleEl.length > 0) {
    title = ctx.helpers.normalizeText(titleEl.text());
  }
  
  // Cover - #cover-img
  let coverUrl = '';
  const coverImg = $d('#cover-img');
  if (coverImg.length > 0) {
    coverUrl = coverImg.attr('data-src') || coverImg.attr('src') || '';
    if (coverUrl && !coverUrl.startsWith('http')) {
      coverUrl = `https:${coverUrl}`;
    }
  }
  
  // Summary - Chinese intro text
  let summary = '';
  const zhIntro = $d('.text-zh .intro-text');
  if (zhIntro.length > 0) {
    summary = ctx.helpers.normalizeText(zhIntro.text());
  }
  if (!summary) {
    const jpIntro = $d('.intro-text.text-jp');
    if (jpIntro.length > 0) {
      summary = ctx.helpers.normalizeText(jpIntro.text());
    }
  }
  
  // Metadata from .attributes dl
  let releaseDate = '';
  let maker = '';
  let publisher = '';
  let series = '';
  let director = '';
  
  const dl = $d('.attributes dl');
  if (dl.length > 0) {
    const dds = dl.find('dd');
    const dts = dl.find('dt');
    
    dds.each((i, ddEl) => {
      const label = $d(ddEl).text().trim();
      const dtEl = dts.eq(i);
      if (dtEl.length === 0) return;
      
      let value = '';
      // Check if dt contains an <a> tag
      const aTag = dtEl.find('a');
      if (aTag.length > 0) {
        value = ctx.helpers.normalizeText(aTag.text());
      } else {
        value = ctx.helpers.normalizeText(dtEl.text());
      }
      
      if (!value) return;
      
      if (label === '发行日期') {
        releaseDate = value;
      } else if (label === '片商') {
        maker = value;
      } else if (label === '厂牌') {
        publisher = value;
      } else if (label === '导演') {
        director = value;
      } else if (label === '系列' || label === 'series') {
        series = value;
      }
    });
  }
  
  // Actresses
  let actresses = [];
  $d('.actors a.actress').each((i, el) => {
    const name = ctx.helpers.normalizeText($d(el).text());
    if (name) {
      const avatarImg = $d(el).find('img.avatar').first();
      let avatarUrl = '';
      if (avatarImg.length > 0) {
        avatarUrl = avatarImg.attr('src') || '';
        if (avatarUrl && !avatarUrl.startsWith('http')) {
          avatarUrl = `https:${avatarUrl}`;
        }
      }
      actresses.push({
        name: name,
        avatarUrl: avatarUrl,
        gender: 'female'
      });
    }
  });
  
  // Tags
  let tags = [];
  $d('.tags a.tag').each((i, el) => {
    const tag = ctx.helpers.normalizeText($d(el).text());
    if (tag) {
      tags.push(tag);
    }
  });
  
  // Samples - all .embla__slide img except the cover
  let sampleImageUrls = [];
  $d('.embla__slide img.embla__slide__img').each((i, el) => {
    // Skip the cover image (has id="cover-img")
    if ($d(el).attr('id') === 'cover-img') return;
    
    let src = $d(el).attr('data-src') || $d(el).attr('src') || '';
    // Skip placeholder data URIs
    if (src && !src.startsWith('data:')) {
      if (!src.startsWith('http')) src = `https:${src}`;
      sampleImageUrls.push(src);
    }
  });
  
  // Normalize release date
  if (releaseDate) {
    releaseDate = ctx.helpers.normalizeDate(releaseDate);
  }
  
  return {
    code: code,
    title: title,
    summary: summary,
    coverUrl: coverUrl,
    releaseDate: releaseDate,
    maker: maker,
    publisher: publisher,
    series: series || undefined,
    director: director || undefined,
    sourceUrl: detailUrl,
    sampleImageUrls: sampleImageUrls.length > 0 ? sampleImageUrls : undefined,
    actresses: actresses.length > 0 ? actresses : undefined,
    tags: tags.length > 0 ? tags : undefined
  };
}

module.exports = { parseVideo };