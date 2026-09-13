/** Real default NFO adapter, temporary synthetic catalog/media only. Run in isolation. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../packages/library/src/db/database'
import { createMediaLibrary } from '../../packages/library/src/db/mediaLibraryRepo'
import { createDefaultLocalNfoSourceAdapter } from '../../apps/desktop/src/main/metadata-sources'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'

it('measures default NFO collection and directory read counts with many resources in one directory', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-production-probe-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = temp; resetSettingsCacheForTests()
  const results: unknown[] = []
  try {
    for (const count of [100, 1000]) {
      const media = path.join(temp, `media-${count}`); fs.mkdirSync(media)
      const db = initDatabaseAtPath(path.join(temp, `catalog-${count}.db`))
      const library = createMediaLibrary({ name: 'NFO probe', roots: [{ path: media }] })
      db.prepare("INSERT INTO videos(id,code) VALUES(1,'ABC-001')").run()
      db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(?,1,1)').run(library.id)
      const insert = db.prepare(`INSERT INTO video_resources(library_id,root_id,video_id,kind,locator,resource_key,source_identity)
        VALUES(?,?,1,'local',?,?,?)`)
      db.transaction(() => {
        for (let index = 1; index <= count; index++) {
          const file = path.join(media, `ABC-001-CD${index}.mp4`)
          fs.writeFileSync(file, 'synthetic')
          insert.run(library.id, library.roots[0].id, file, `local:${file}`, file)
        }
      })()
      fs.writeFileSync(path.join(media, 'movie.nfo'), '<movie><num>ABC-001</num><title>Probe title</title></movie>')
      const source = createDefaultLocalNfoSourceAdapter(), samples: unknown[] = []
      for (let sample = -1; sample < 3; sample++) {
        const original = fs.readdirSync
        let directoryReads = 0
        fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
          if (String(args[0]) === media) directoryReads++
          return Reflect.apply(original, fs, args)
        }) as typeof fs.readdirSync
        try {
          const start = performance.now()
          const batch = await source.collect({ target: { kind: 'video', videoId: 1, code: 'ABC-001' }, fields: ['title'] })
          const elapsedMs = performance.now() - start
          assert.equal(batch.candidates.length, 1)
          assert.equal(batch.candidates[0].result.title, 'Probe title')
          if (sample >= 0) samples.push({ elapsedMs, directoryReads, candidates: batch.candidates.length })
        } finally { fs.readdirSync = original }
      }
      results.push({ count, samples })
      closeDatabase(); resetSettingsCacheForTests()
    }
  } finally {
    closeDatabase(); resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(temp, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ results, notes: [
    'Actual default adapter, same-video local parts sharing one movie.nfo; title-only collection with real catalog/root/file authorization.',
    'One warmup plus3 samples per scale; includes collect and directory read counting, excludes fixture setup and candidate application.',
    'Repeated calls remain separate requests. Ordinary cache-warm temporary filesystem; no cold disk, p95, Windows/HDD, concurrent devices or peak RSS claim.',
    'Other file authorization/stat/read work remains; this measures request-local directory reuse, not full scan throughput.'
  ] }, null, 2))
})
