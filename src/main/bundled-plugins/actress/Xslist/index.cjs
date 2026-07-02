/**
 * Xslist.org 演员资料刮削插件
 * 支持字段：avatar, gallery, birthDate, nameZh, nameEn, debutDate, heightCm, measurements, cupSize, bloodType, zodiac, nationality, profileSummary, aliases
 */

const BASE_URL = 'https://xslist.org';

/**
 * 搜索演员，返回资料页 URL
 */
async function searchActress(ctx, name) {
  if (!name || !name.trim()) return null;
  
  const searchUrl = `${BASE_URL}/search?query=${encodeURIComponent(name.trim())}&lg=zh`;
  const html = await ctx.fetchPage(searchUrl, { timeoutMs: 10000 });
  
  if (!html || html.length < 10) return null;
  
  const $ = ctx.cheerio.load(html);
  const link = $('ul.r li.clearfix h3 a').first().attr('href');
  
  if (link) {
    // Ensure we use zh language version
    return link.replace('/en/', '/zh/');
  }
  
  return null;
}

/**
 * 解析资料页
 */
function parseDetail($, ctx) {
  const result = {};
  
  // --- 主名 (mainName) ---
  const mainName = $('h1 span[itemprop="name"]').first().text().trim();
  if (mainName) result.mainName = mainName;
  
  // --- 英文名 (nameEn) - from h1 text like "三上悠亜(Yua Mikami/32岁)" or "伊藤舞雪(Mayuki Ito)" ---
  const h1Text = $('h1').first().text().trim();
  const nameEnMatch = h1Text.match(/\(([^)\/]+)(?:\/|\))/);
  if (nameEnMatch) {
    result.nameEn = nameEnMatch[1].trim();
  }
  
  // --- 别名 (aliases) ---
  const aliases = [];
  $('span[itemprop="additionalName"]').each((i, el) => {
    const alias = $(el).text().trim();
    if (alias) aliases.push(alias);
  });
  if (aliases.length > 0) result.aliases = aliases;
  
  // --- 头像 (avatarUrl) ---
  const avatarUrl = $('.profile_img_c img').first().attr('src');
  if (avatarUrl) result.avatarUrl = avatarUrl;
  
  // --- 个人资料文本解析 ---
  const pageText = $('#layout').text();
  
  // 出生: 1993年08月15日
  const birthMatch = pageText.match(/出生:\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (birthMatch) {
    result.birthDate = `${birthMatch[1]}-${birthMatch[2].padStart(2, '0')}-${birthMatch[3].padStart(2, '0')}`;
  }
  
  // 三围: B84 / W59 / H88
  const measurementsMatch = pageText.match(/三围:\s*B(\d+)\s*\/\s*W(\d+)\s*\/\s*H(\d+)/);
  if (measurementsMatch) {
    result.bustCm = parseInt(measurementsMatch[1], 10);
    result.waistCm = parseInt(measurementsMatch[2], 10);
    result.hipCm = parseInt(measurementsMatch[3], 10);
  }
  
  // 罩杯: E Cup
  const cupMatch = pageText.match(/罩杯:\s*([A-Z])\s*Cup/i);
  if (cupMatch) {
    result.cupSize = cupMatch[1].toUpperCase();
  }
  
  // 身高: 159cm
  const heightEl = $('span[itemprop="height"]').first();
  if (heightEl.length) {
    const heightText = heightEl.text().trim();
    const heightMatch = heightText.match(/(\d+)/);
    if (heightMatch) {
      result.heightCm = parseInt(heightMatch[1], 10);
    }
  }
  
  // 出道日期: 2015年05月
  const debutMatch = pageText.match(/出道日期:\s*(\d{4})年(\d{1,2})月/);
  if (debutMatch) {
    result.debutDate = `${debutMatch[1]}-${debutMatch[2].padStart(2, '0')}-01`;
  }
  
  // 星座: Leo
  const zodiacMatch = pageText.match(/星座:\s*([^\s\n\r<]+)/);
  if (zodiacMatch) {
    result.zodiac = zodiacMatch[1].trim();
  }
  
  // 血型: A (from HTML, text may have <br> or spaces)
  const bloodMatch = pageText.match(/血型:\s*(\S+)/);
  if (bloodMatch) {
    result.bloodType = bloodMatch[1].trim();
  }
  
  // 国籍
  const nationalityEl = $('span[itemprop="nationality"]').first();
  if (nationalityEl.length) {
    result.nationality = nationalityEl.text().trim();
  }
  
  // 简介
  const introP = $('#layout p').filter((i, el) => {
    return $(el).text().trim().startsWith('简介:');
  }).first();
  if (introP.length) {
    let summary = introP.text().replace('简介:', '').trim();
    if (summary && !summary.includes('暂无关于')) {
      result.profileSummary = summary;
    }
  }
  
  // --- 写真 (galleryImageUrls) ---
  const galleryUrls = [];
  $('#gallery a.gallery-item').each((i, el) => {
    const href = $(el).attr('href');
    if (href) galleryUrls.push(href);
  });
  if (galleryUrls.length > 0) result.galleryImageUrls = galleryUrls;
  
  return result;
}

/**
 * 主入口：parseActress
 */
async function parseActress(ctx) {
  const names = [ctx.mainName, ...(ctx.aliases || [])].filter(Boolean);
  
  let profileUrl = null;
  let usedName = null;
  
  // Try each name to search
  for (const name of names) {
    const url = await searchActress(ctx, name);
    if (url) {
      profileUrl = url;
      usedName = name;
      break;
    }
  }
  
  if (!profileUrl) {
    return null;
  }
  
  // Fetch profile page
  const html = await ctx.fetchPage(profileUrl, { timeoutMs: 15000 });
  if (!html || html.length < 100) return null;
  
  const $ = ctx.cheerio.load(html);
  const result = parseDetail($, ctx);
  
  // Set source URL
  result.sourceUrl = profileUrl;
  
  return result;
}

module.exports = { parseActress };