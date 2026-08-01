import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { addActressGalleryAsset, editActress, getActressDetail } from '../db/actressRepo'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scrapeActress } from './actressScraperManager'
import { scrapeBrowser } from './scrapeBrowser'
import {
  createCompositeScraper,
  installScraperPluginPackage
} from './scraperPluginService'

let tempRoot: string | null = null
let previousUserData: string | undefined

const MINIMAL_JPEG = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

function seedGfriendsIndex(content: Record<string, Record<string, string>>): void {
  assert.ok(tempRoot)
  const url = 'https://raw.githubusercontent.com/gfriends/gfriends/master/Filetree.json'
  const pluginDigest = crypto
    .createHash('sha256')
    .update('actress\0Gfriends')
    .digest('hex')
  const resourceDigest = crypto.createHash('sha256').update(url).digest('hex')
  const pluginDir = path.join(tempRoot, 'scraper_resource_cache', pluginDigest)
  const bodyFile = `${resourceDigest}.fixture.bin`
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, bodyFile), JSON.stringify({ Content: content }))
  fs.writeFileSync(
    path.join(pluginDir, `${resourceDigest}.json`),
    JSON.stringify({
      schemaVersion: 2,
      url,
      fetchedAt: Date.now(),
      bodyFile,
      etag: '"fixture"'
    })
  )
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-scraper-manager-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('actressScraperManager', () => {
  it('clears the selected avatar in replace mode when the matched source has no avatar', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'No Avatar Profile Source',
      version: '1.0.0',
      description: 'Matches a profile without returning an avatar',
      supportedFields: ['avatar'],
      code: `
module.exports = {
  async parseActress(ctx) {
    return { mainName: ctx.mainName };
  }
};
`
    })
    assert.ok(tempRoot)
    const avatarRelPath = 'avatars/existing.jpg'
    const avatarAbsPath = path.join(tempRoot, 'media_assets', avatarRelPath)
    fs.mkdirSync(path.dirname(avatarAbsPath), { recursive: true })
    fs.writeFileSync(avatarAbsPath, MINIMAL_JPEG)
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender, avatar_path) VALUES (?, ?, ?)')
      .run('Replace Empty Avatar Actress', 'female', avatarRelPath)
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'No Avatar Profile Source', {
      fields: ['avatar'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(getActressDetail(actressId)?.avatar_path, null)
    assert.equal(fs.existsSync(avatarAbsPath), false)
  })

  it('promotes an unscraped actress to scrape success when a profile field is applied', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Successful Profile Source',
      version: '1.0.0',
      description: 'Returns one valid profile field',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return { birthDate: '1992-03-04' };
  }
};
`
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Status Success Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Successful Profile Source', {
      fields: ['birthDate'],
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, true)
    assert.equal(detail?.birth_date, '1992-03-04')
    assert.equal(detail?.scraped_status, 1)
    assert.ok(detail?.last_scraped_at)
  })

  it('records a failed scrape without a success time when no profile matches', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'No Match Profile Source',
      version: '1.0.0',
      description: 'Returns no matching profile',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return null;
  }
};
`
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('No Match Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'No Match Profile Source', {
      fields: ['birthDate'],
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /未找到匹配/)
    assert.equal(detail?.scraped_status, 2)
    assert.equal(detail?.last_scraped_at, null)
  })

  it('records a failed scrape without a success time when the source throws', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Throwing Profile Source',
      version: '1.0.0',
      description: 'Throws while scraping a profile',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    throw new Error('profile source offline');
  }
};
`
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Exception Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Throwing Profile Source', {
      fields: ['birthDate'],
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /profile source offline/)
    assert.equal(detail?.scraped_status, 2)
    assert.equal(detail?.last_scraped_at, null)
  })

  it('records failure in replace-if-present mode when a matched profile has no selected value', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Empty Profile Source',
      version: '1.0.0',
      description: 'Returns a profile without usable fields',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return {};
  }
};
`
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Empty Result Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Empty Profile Source', {
      fields: ['birthDate'],
      mode: 'replaceIfPresent',
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /有效/)
    assert.equal(detail?.scraped_status, 2)
    assert.equal(detail?.last_scraped_at, null)
    assert.equal(detail?.birth_date, null)
  })

  it('promotes a previously failed actress when a later scrape applies valid data', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Recovery Profile Source',
      version: '1.0.0',
      description: 'Returns valid data after an earlier failed attempt',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return { birthDate: '1993-04-05' };
  }
};
`
    })
    const inserted = getDb()
      .prepare(
        'INSERT INTO actresses (main_name, gender, scraped_status) VALUES (?, ?, ?)'
      )
      .run('Recovered Actress', 'female', 2)
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Recovery Profile Source', {
      fields: ['birthDate'],
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, true)
    assert.equal(detail?.scraped_status, 1)
    assert.ok(detail?.last_scraped_at)
    assert.equal(detail?.birth_date, '1993-04-05')
  })

  it('skips fill-empty scraping without changing cumulative status when no selected field is missing', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Must Not Run Profile Source',
      version: '1.0.0',
      description: 'Throws if an already-complete field is scraped',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    throw new Error('completed fields should have been skipped');
  }
};
`
    })
    const inserted = getDb()
      .prepare(
        `INSERT INTO actresses
          (main_name, gender, birth_date, scraped_status, last_scraped_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('Skipped Actress', 'female', '1994-05-06', 2, null)
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Must Not Run Profile Source', {
      fields: ['birthDate'],
      mode: 'fillEmpty',
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.skipped, true)
    assert.equal(detail?.birth_date, '1994-05-06')
    assert.equal(detail?.scraped_status, 2)
    assert.equal(detail?.last_scraped_at, null)
  })

  it('keeps cumulative success and its timestamp when a later scrape fails', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Later Failure Profile Source',
      version: '1.0.0',
      description: 'Returns no match after an earlier success',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return null;
  }
};
`
    })
    const successfulAt = '2025-06-07T08:09:10.000Z'
    const inserted = getDb()
      .prepare(
        `INSERT INTO actresses
          (main_name, gender, birth_date, scraped_status, last_scraped_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('Cumulative Success Actress', 'female', '1995-06-07', 1, successfulAt)
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Later Failure Profile Source', {
      fields: ['birthDate'],
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, false)
    assert.equal(detail?.scraped_status, 1)
    assert.equal(detail?.last_scraped_at, successfulAt)
    assert.equal(detail?.birth_date, '1995-06-07')
  })

  it('lets Gfriends try stored aliases after the main name without enabling global alias search', async () => {
    seedGfriendsIndex({
      Studio: {
        'Alias Actress.jpg': 'Alias Actress.jpg?t=1'
      }
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Missing Main Name', 'female')
    const actressId = Number(inserted.lastInsertRowid)
    editActress(actressId, { aliases: ['Alias Actress'] })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG

    try {
      const outcome = await scrapeActress(actressId, 'Gfriends', {
        fields: ['avatar'],
        closeBrowser: false
      })

      assert.equal(outcome.ok, true)
      assert.ok(getActressDetail(actressId)?.avatar_path)
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('applies successful field sources when another source fails', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Broken Avatar Source',
      version: '1.0.0',
      description: 'Fails while fetching avatars',
      supportedFields: ['avatar'],
      code: `
module.exports = {
  async parseActress() {
    throw new Error('avatar source offline');
  }
};
`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Profile Source',
      version: '1.0.0',
      description: 'Returns profile fields',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return { birthDate: '1990-01-02' };
  }
};
`
    })
    createCompositeScraper('actress', {
      name: 'Resilient Composite',
      fieldPluginMap: {
        avatar: 'Broken Avatar Source',
        birthDate: 'Profile Source'
      }
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Test Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Resilient Composite', {
      fields: ['avatar', 'birthDate'],
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.warnings?.some((warning) => warning.includes('avatar source offline')), true)
    const detail = getActressDetail(actressId)
    assert.equal(detail?.birth_date, '1990-01-02')
    assert.equal(detail?.scraped_status, 1)
    assert.ok(detail?.last_scraped_at)
  })

  it('preserves a field in replace mode when its composite source fails', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Failed Composite Avatar Source',
      version: '1.0.0',
      description: 'Fails while scraping avatars',
      supportedFields: ['avatar'],
      code: `
module.exports = {
  async parseActress() {
    throw new Error('avatar source offline');
  }
};
`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Successful Composite Birth Source',
      version: '1.0.0',
      description: 'Returns a birth date',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return { birthDate: '1990-01-02' };
  }
};
`
    })
    createCompositeScraper('actress', {
      name: 'Partial Failure Replace Composite',
      fieldPluginMap: {
        avatar: 'Failed Composite Avatar Source',
        birthDate: 'Successful Composite Birth Source'
      }
    })
    assert.ok(tempRoot)
    const avatarRelPath = 'avatars/composite-failure-existing.jpg'
    const avatarAbsPath = path.join(tempRoot, 'media_assets', avatarRelPath)
    fs.mkdirSync(path.dirname(avatarAbsPath), { recursive: true })
    fs.writeFileSync(avatarAbsPath, MINIMAL_JPEG)
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender, avatar_path) VALUES (?, ?, ?)')
      .run('Composite Failure Actress', 'female', avatarRelPath)
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Partial Failure Replace Composite', {
      fields: ['avatar', 'birthDate'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.warnings?.some((warning) => warning.includes('avatar source offline')), true)
    assert.equal(getActressDetail(actressId)?.avatar_path, avatarRelPath)
    assert.equal(fs.existsSync(avatarAbsPath), true)
  })

  it('clears a field in replace mode when its composite source matched with no value', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Empty Composite Avatar Source',
      version: '1.0.0',
      description: 'Matches without returning an avatar',
      supportedFields: ['avatar'],
      code: `
module.exports = {
  async parseActress(ctx) {
    return { mainName: ctx.mainName };
  }
};
`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Matched Composite Birth Source',
      version: '1.0.0',
      description: 'Returns a birth date',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return { birthDate: '1990-01-02' };
  }
};
`
    })
    createCompositeScraper('actress', {
      name: 'Matched Empty Replace Composite',
      fieldPluginMap: {
        avatar: 'Empty Composite Avatar Source',
        birthDate: 'Matched Composite Birth Source'
      }
    })
    assert.ok(tempRoot)
    const avatarRelPath = 'avatars/composite-empty-existing.jpg'
    const avatarAbsPath = path.join(tempRoot, 'media_assets', avatarRelPath)
    fs.mkdirSync(path.dirname(avatarAbsPath), { recursive: true })
    fs.writeFileSync(avatarAbsPath, MINIMAL_JPEG)
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender, avatar_path) VALUES (?, ?, ?)')
      .run('Composite Empty Actress', 'female', avatarRelPath)
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'Matched Empty Replace Composite', {
      fields: ['avatar', 'birthDate'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(getActressDetail(actressId)?.avatar_path, null)
    assert.equal(fs.existsSync(avatarAbsPath), false)
  })

  it('records failure when every configured composite source fails', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Broken Composite Avatar Source',
      version: '1.0.0',
      description: 'Fails while fetching avatars',
      supportedFields: ['avatar'],
      code: `
module.exports = {
  async parseActress() {
    throw new Error('avatar source offline');
  }
};
`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Broken Composite Profile Source',
      version: '1.0.0',
      description: 'Fails while fetching profile fields',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    throw new Error('profile source offline');
  }
};
`
    })
    createCompositeScraper('actress', {
      name: 'All Broken Composite',
      fieldPluginMap: {
        avatar: 'Broken Composite Avatar Source',
        birthDate: 'Broken Composite Profile Source'
      }
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('All Sources Failed Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)

    const outcome = await scrapeActress(actressId, 'All Broken Composite', {
      fields: ['avatar', 'birthDate'],
      closeBrowser: false
    })

    const detail = getActressDetail(actressId)
    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /avatar source offline/)
    assert.match(outcome.error ?? '', /profile source offline/)
    assert.equal(detail?.scraped_status, 2)
    assert.equal(detail?.last_scraped_at, null)
  })

  it('warns when a composite avatar source cannot download its result', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Unavailable Avatar Source',
      version: '1.0.0',
      description: 'Returns an unavailable avatar',
      supportedFields: ['avatar'],
      code: `
module.exports = {
  async parseActress() {
    return { avatarUrl: 'https://example.invalid/avatar.jpg' };
  }
};
`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Download Profile Source',
      version: '1.0.0',
      description: 'Returns profile fields',
      supportedFields: ['birthDate'],
      code: `
module.exports = {
  async parseActress() {
    return { birthDate: '1991-02-03' };
  }
};
`
    })
    createCompositeScraper('actress', {
      name: 'Download Resilient Composite',
      fieldPluginMap: {
        avatar: 'Unavailable Avatar Source',
        birthDate: 'Download Profile Source'
      }
    })
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Download Test Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => {
      throw new Error('avatar host offline')
    }

    try {
      const outcome = await scrapeActress(actressId, 'Download Resilient Composite', {
        fields: ['avatar', 'birthDate'],
        closeBrowser: false
      })

      assert.equal(outcome.ok, true)
      assert.equal(
        outcome.warnings?.some(
          (warning) =>
            warning.includes('Unavailable Avatar Source') &&
            warning.includes('头像下载失败')
        ),
        true
      )
      assert.equal(getActressDetail(actressId)?.birth_date, '1991-02-03')
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('preserves the existing gallery when every returned image is unusable', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'actress',
      name: 'Remote Gallery Source',
      version: '1.0.0',
      description: 'Returns a gallery whose local download is unavailable',
      supportedFields: ['gallery'],
      code: `
module.exports = {
  async parseActress() {
    return { galleryImageUrls: ['https://example.invalid/gallery.jpg'] };
  }
};
`
    })
    createCompositeScraper('actress', {
      name: 'Remote Gallery Composite',
      fieldPluginMap: {
        gallery: 'Remote Gallery Source'
      }
    })
    assert.ok(tempRoot)
    const existingRelPath = 'actress-gallery/existing.jpg'
    const existingAbsPath = path.join(tempRoot, 'media_assets', existingRelPath)
    fs.mkdirSync(path.dirname(existingAbsPath), { recursive: true })
    fs.writeFileSync(existingAbsPath, MINIMAL_JPEG)
    const inserted = getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run('Remote Gallery Actress', 'female')
    const actressId = Number(inserted.lastInsertRowid)
    addActressGalleryAsset(actressId, {
      remoteUrl: 'https://example.invalid/existing.jpg',
      localPath: existingRelPath,
      width: 1,
      height: 1
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => {
      return Buffer.from('<html>not an image</html>')
    }

    try {
      const outcome = await scrapeActress(actressId, 'Remote Gallery Composite', {
        fields: ['gallery'],
        mode: 'replace',
        closeBrowser: false
      })

      const detail = getActressDetail(actressId)
      assert.equal(outcome.ok, false)
      assert.equal(outcome.warnings?.some((warning) => warning.includes('写真下载失败')), true)
      assert.equal(detail?.scraped_status, 2)
      assert.equal(detail?.last_scraped_at, null)
      assert.deepEqual(
        detail?.gallery.map((asset) => ({
          remoteUrl: asset.remote_url,
          localPath: asset.local_path
        })),
        [{ remoteUrl: 'https://example.invalid/existing.jpg', localPath: existingRelPath }]
      )
      assert.equal(fs.existsSync(existingAbsPath), true)
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })
})
