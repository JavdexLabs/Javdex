async function parseActress(ctx) {
  const BASE_URL = 'https://www.ouxiangdanganku.com';
  const { mainName, aliases = [] } = ctx;
  const names = [mainName, ...aliases].filter(Boolean);

  for (const name of names) {
    // Step 1: Search
    const searchUrl = BASE_URL + '/search/' + encodeURIComponent(name);
    let searchHtml;
    try {
      searchHtml = await ctx.fetchPage(searchUrl, { readySelector: '.r-item', timeoutMs: 30000 });
    } catch (e) {
      continue;
    }
    const $search = ctx.cheerio.load(searchHtml);

    // Find the best match - first result with high match percentage
    let profileUrl = null;
    let matchedText = '';
    $search('.r-item').each((i, el) => {
      if (i === 0 && !profileUrl) {
        const link = $search(el).find('dt a').first();
        const href = link.attr('href');
        const text = link.text().trim();
        if (href && text) {
          profileUrl = ctx.helpers.absoluteUrl(href, searchUrl);
          matchedText = text;
        }
      }
    });

    if (!profileUrl) continue;

    // Step 2: Fetch profile page
    let profileHtml;
    try {
      profileHtml = await ctx.fetchPage(profileUrl, { readySelector: '.info-box, .people-title', timeoutMs: 30000 });
    } catch (e) {
      continue;
    }
    const $ = ctx.cheerio.load(profileHtml);

    // Step 3: Parse info-box table
    const infoBox = $('.info-box');
    if (!infoBox.length) continue;

    const infoData = {};
    infoBox.find('table tr').each((i, tr) => {
      const $tr = $(tr);
      const label = $tr.find('td').first().text().trim();
      const value = $tr.find('td').last().text().trim();
      if (label && value) {
        infoData[label] = value;
      }
    });

    // Parse fields from infoData
    const result = {};

    // mainName
    result.mainName = infoData['名字'] || mainName;

    // nameZh
    if (infoData['中文名']) {
      result.nameZh = infoData['中文名'];
    }

    // nameEn
    if (infoData['外文名']) {
      result.nameEn = infoData['外文名'];
    }

    // birthDate
    if (infoData['出生日期']) {
      const bd = infoData['出生日期'].trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(bd)) {
        result.birthDate = bd;
      }
    }

    // debutDate - 出道时间 is just year
    if (infoData['出道时间']) {
      const year = infoData['出道时间'].trim();
      if (/^\d{4}$/.test(year)) {
        result.debutDate = year + '-01-01';
      }
    }

    // bloodType
    if (infoData['血型']) {
      const bt = infoData['血型'].replace('型', '').trim();
      if (bt) result.bloodType = bt;
    }

    // zodiac
    if (infoData['星座']) {
      result.zodiac = infoData['星座'];
    }

    // nationality
    if (infoData['国籍']) {
      result.nationality = infoData['国籍'];
    }

    // height
    if (infoData['身高']) {
      const hMatch = infoData['身高'].match(/(\d+)/);
      if (hMatch) {
        result.heightCm = parseInt(hMatch[1], 10);
      }
    }

    // measurements (三围)
    if (infoData['三围']) {
      const mMatch = infoData['三围'].match(/B(\d+)\(?([A-Z])?\)?-?W(\d+)-?H(\d+)/);
      if (mMatch) {
        result.bustCm = parseInt(mMatch[1], 10);
        result.waistCm = parseInt(mMatch[3], 10);
        result.hipCm = parseInt(mMatch[4], 10);
        if (mMatch[2]) {
          result.cupSize = mMatch[2];
        }
      } else {
        // Try simpler pattern B84-W57-H82
        const mSimple = infoData['三围'].match(/B(\d+)-W(\d+)-H(\d+)/);
        if (mSimple) {
          result.bustCm = parseInt(mSimple[1], 10);
          result.waistCm = parseInt(mSimple[2], 10);
          result.hipCm = parseInt(mSimple[3], 10);
        }
      }
    }

    // aliases
    const aliasList = [];
    if (infoData['别名']) {
      aliasList.push(infoData['别名']);
    }
    if (infoData['呢称']) {
      aliasList.push(infoData['呢称']);
    }
    if (aliasList.length > 0) {
      // Split by common separators including newlines
      const allAliases = [];
      aliasList.forEach(a => {
        a.split(/[,，、\/\n]/).forEach(part => {
          const p = part.trim();
          if (p) allAliases.push(p);
        });
      });
      result.aliases = ctx.helpers.unique(allAliases);
    }

    // avatar - use the info-box image
    const avatarImg = infoBox.find('> img').first();
    if (avatarImg.length) {
      const src = avatarImg.attr('src');
      if (src) {
        result.avatarUrl = ctx.helpers.absoluteUrl(src, profileUrl);
      }
    }

    // gallery - from photo-gallery section
    const galleryImages = [];
    $('.photo-gallery .main-slider img').each((i, img) => {
      const src = $(img).attr('src');
      if (src) {
        galleryImages.push(ctx.helpers.absoluteUrl(src, profileUrl));
      }
    });
    if (galleryImages.length > 0) {
      result.galleryImageUrls = ctx.helpers.unique(galleryImages);
    }

    // profileSummary - from intro section
    const introText = $('#intro p').first().text().trim();
    if (introText) {
      result.profileSummary = introText;
    }

    return result;
  }

  return null;
}

module.exports = { parseActress };