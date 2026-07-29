import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { editActress, getActressDetail } from '../db/actressRepo'
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
    assert.equal(getActressDetail(actressId)?.birth_date, '1990-01-02')
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
})
