const PRIMARY_ROOT = 'https://raw.githubusercontent.com/gfriends/gfriends/master/'
const FALLBACK_ROOT = 'https://cdn.jsdelivr.net/gh/gfriends/gfriends@master/'
const INDEX_CACHE_OPTIONS = {
  cache: {
    mode: 'persistent',
    maxAgeMs: 24 * 60 * 60 * 1000,
    staleIfError: true
  }
}

async function loadIndex(ctx) {
  let lastError
  for (const root of [PRIMARY_ROOT, FALLBACK_ROOT]) {
    try {
      const body = await ctx.fetchBuffer(`${root}Filetree.json`, INDEX_CACHE_OPTIONS)
      const parsed = JSON.parse(body.toString('utf-8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.Content) {
        throw new Error('Gfriends Filetree.json is missing Content')
      }
      return { content: parsed.Content, root }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Unable to load Gfriends Filetree.json')
}

function findLastCandidate(content, name) {
  const expected = String(name || '').trim()
  if (!expected) return null
  let candidate = null

  for (const [company, entries] of Object.entries(content)) {
    if (!entries || typeof entries !== 'object') continue
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== 'string' || !key.toLowerCase().endsWith('.jpg')) continue
      const stem = key.slice(0, -4)
      const suffix = stem.startsWith(`${expected}-`) ? stem.slice(expected.length + 1) : ''
      if (stem === expected || /^\d+$/.test(suffix)) {
        candidate = { company, value }
      }
    }
  }

  return candidate
}

function buildAvatarUrl(root, candidate) {
  const separator = candidate.value.indexOf('?')
  const fileName = separator >= 0 ? candidate.value.slice(0, separator) : candidate.value
  const query = separator >= 0 ? candidate.value.slice(separator) : ''
  const encodedFileName = fileName.split('/').map(encodeURIComponent).join('/')
  return `${root}Content/${encodeURIComponent(candidate.company)}/${encodedFileName}${query}`
}

async function parseActress(ctx) {
  const { content, root } = await loadIndex(ctx)
  const names = [ctx.mainName, ...(ctx.aliases || [])]

  for (const name of names) {
    const candidate = findLastCandidate(content, name)
    if (candidate) return { avatarUrl: buildAvatarUrl(root, candidate) }
  }

  return null
}

module.exports = { parseActress }
