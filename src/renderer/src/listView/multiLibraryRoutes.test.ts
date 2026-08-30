import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  homeVideoActressPath,
  homeVideoDetailPath,
  parseHomeVideoPath
} from './homeRoutes'
import {
  MEDIA_LIBRARY_SETTINGS_TABS,
  isMediaLibrarySettingsTab,
  mediaLibraryPath,
  mediaLibrarySettingsPath,
  mediaLibraryVideoActressPath,
  mediaLibraryVideoDetailPath,
  parseActiveMediaLibraryId,
  parseMediaLibraryRoute,
  parseMediaLibrarySettingsLibraryId,
  parseMediaLibrarySettingsPath,
  parseMediaLibraryVideoPath,
  peekMediaLibrarySettingsLibraryId,
  rememberMediaLibrarySettingsLibraryId,
  clearMediaLibrarySettingsLibraryMemory
} from './mediaLibraryRoutes'
import {
  parseSearchVideoPath,
  searchVideoActressPath,
  searchVideoDetailPath
} from './searchRoutes'
import {
  VIDEO_DETAIL_LIBRARY_PARAM,
  canonicalizeVideoDetailLocationSearch,
  canonicalizeVideoDetailSearchParams,
  loadLegacyDetailForRedirect,
  parseVideoDetailLibraryId,
  parseVideoDetailRouteContext,
  setVideoDetailLibraryId,
  stripVideoDetailSearchParams
} from './videoDetailContext'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import {
  libraryVideoActressPath,
  libraryVideoDetailPath,
  parseLibraryVideoPath
} from './libraryRoutes'

describe('multi-library route builders and parsers', () => {
  it('round-trips the home video detail stack', () => {
    assert.equal(homeVideoDetailPath(42), '/home/video/42')
    assert.equal(homeVideoActressPath(42, 7), '/home/video/42/actress/7')
    assert.deepEqual(parseHomeVideoPath('/home/video/42'), { videoId: 42 })
    assert.deepEqual(parseHomeVideoPath('/home/video/42/actress/7'), {
      videoId: 42,
      actressId: 7
    })
  })

  it('round-trips the global-search video detail stack', () => {
    assert.equal(searchVideoDetailPath(42), '/search/video/42')
    assert.equal(searchVideoActressPath(42, 7), '/search/video/42/actress/7')
    assert.deepEqual(parseSearchVideoPath('/search/video/42'), { videoId: 42 })
    assert.deepEqual(parseSearchVideoPath('/search/video/42/actress/7'), {
      videoId: 42,
      actressId: 7
    })
  })

  it('round-trips media-library list, detail, nested actress and settings routes', () => {
    assert.deepEqual(MEDIA_LIBRARY_SETTINGS_TABS, [
      'sources',
      'general',
      'scraping',
      'display',
      'danger'
    ])
    assert.equal(mediaLibraryPath(3), '/libraries/3')
    assert.equal(mediaLibraryVideoDetailPath(3, 42), '/libraries/3/video/42')
    assert.equal(
      mediaLibraryVideoActressPath(3, 42, 7),
      '/libraries/3/video/42/actress/7'
    )
    assert.equal(
      mediaLibrarySettingsPath(3, 'sources'),
      '/settings/library/sources?library=3'
    )
    assert.equal(parseMediaLibrarySettingsLibraryId('?library=003'), 3)
    assert.equal(parseMediaLibrarySettingsLibraryId('?library=invalid'), null)
    assert.equal(isMediaLibrarySettingsTab('scan'), false)

    assert.deepEqual(parseMediaLibraryRoute('/libraries/3'), {
      kind: 'list',
      libraryId: 3
    })
    assert.deepEqual(parseMediaLibraryVideoPath('/libraries/3/video/42/actress/7'), {
      libraryId: 3,
      videoId: 42,
      actressId: 7
    })
    assert.deepEqual(parseMediaLibrarySettingsPath('/libraries/3/settings/display'), {
      libraryId: 3,
      tab: 'display'
    })
    assert.deepEqual(parseMediaLibraryRoute('/libraries/3/settings/display'), {
      kind: 'settings',
      libraryId: 3,
      tab: 'display'
    })
    assert.equal(parseActiveMediaLibraryId('/libraries/3'), 3)
    assert.equal(
      parseActiveMediaLibraryId('/settings/library/sources', '?library=7'),
      7
    )
    assert.equal(parseActiveMediaLibraryId('/settings/plugins/video', '?library=7'), null)
    clearMediaLibrarySettingsLibraryMemory()
    rememberMediaLibrarySettingsLibraryId(9)
    assert.equal(peekMediaLibrarySettingsLibraryId(), 9)
    clearMediaLibrarySettingsLibraryMemory()
    assert.equal(peekMediaLibrarySettingsLibraryId(), null)
  })

  it('rejects malformed, non-positive, fractional and unsafe route ids', () => {
    const invalidHomePaths = [
      '/home/video/0',
      '/home/video/-1',
      '/home/video/1.5',
      '/home/video/1e3',
      '/home/video/9007199254740992'
    ]
    for (const path of invalidHomePaths) assert.equal(parseHomeVideoPath(path), null)

    assert.equal(parseSearchVideoPath('/search/video/1/actress/0'), null)
    assert.equal(parseMediaLibraryRoute('/libraries/0'), null)
    assert.equal(parseMediaLibraryRoute('/libraries/-1/video/3'), null)
    assert.equal(parseMediaLibraryVideoPath('/libraries/2/video/0'), null)
    assert.equal(parseMediaLibrarySettingsPath('/libraries/2/settings/unknown'), null)
    assert.equal(parseLibraryVideoPath('/detail/0'), null)
    assert.equal(parseLibraryVideoPath('/detail/1.5'), null)

    for (const invalidId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => homeVideoDetailPath(invalidId), RangeError)
      assert.throws(() => searchVideoDetailPath(invalidId), RangeError)
      assert.throws(() => mediaLibraryPath(invalidId), RangeError)
      assert.throws(() => libraryVideoDetailPath(invalidId), RangeError)
    }
    assert.throws(() => libraryVideoActressPath(2, 0), RangeError)
  })

  it('accepts digit-only positive ids and builders emit their canonical form', () => {
    assert.deepEqual(parseHomeVideoPath('/home/video/0042'), { videoId: 42 })
    assert.deepEqual(parseMediaLibraryRoute('/libraries/0003'), {
      kind: 'list',
      libraryId: 3
    })
    assert.equal(mediaLibraryVideoDetailPath(3, 42), '/libraries/3/video/42')
  })
})

describe('detail-only active-library query contract', () => {
  it('parses only positive safe-integer library ids', () => {
    assert.equal(VIDEO_DETAIL_LIBRARY_PARAM, 'lib')
    assert.equal(parseVideoDetailLibraryId(new URLSearchParams('lib=3')), 3)
    assert.equal(parseVideoDetailLibraryId(new URLSearchParams('lib=003')), 3)

    for (const value of ['', '0', '-1', '1.5', '1e3', ' 3 ', '9007199254740992']) {
      assert.equal(parseVideoDetailLibraryId(new URLSearchParams({ lib: value })), null)
    }
  })

  it('canonicalizes the first lib value without changing other list query state', () => {
    const source = new URLSearchParams('q=hero&lib=003&lib=4&status=1')
    const canonical = canonicalizeVideoDetailSearchParams(source)

    assert.equal(canonical.toString(), 'q=hero&lib=3&status=1')
    assert.equal(source.toString(), 'q=hero&lib=003&lib=4&status=1')

    const invalid = canonicalizeVideoDetailSearchParams(
      new URLSearchParams('q=hero&lib=not-a-number')
    )
    assert.equal(invalid.toString(), 'q=hero')
  })

  it('sets, replaces and strips the detail-only library parameter immutably', () => {
    const source = new URLSearchParams('q=hero&lib=2&lib=4')
    const changed = setVideoDetailLibraryId(source, 7)
    const stripped = stripVideoDetailSearchParams(source)

    assert.equal(changed.toString(), 'q=hero&lib=7')
    assert.equal(stripped.toString(), 'q=hero')
    assert.equal(source.toString(), 'q=hero&lib=2&lib=4')
    assert.throws(() => setVideoDetailLibraryId(source, 0), RangeError)
  })

  it('derives a single detail context and gives a library path precedence over lib', () => {
    assert.deepEqual(
      parseVideoDetailRouteContext('/home/video/42', new URLSearchParams('lib=3&q=hero')),
      {
        source: 'home',
        listPath: '/',
        videoId: 42,
        libraryId: 3,
        libraryIdSource: 'query'
      }
    )
    assert.deepEqual(
      parseVideoDetailRouteContext(
        '/search/video/42/actress/7',
        new URLSearchParams('q=hero')
      ),
      {
        source: 'search',
        listPath: '/search',
        videoId: 42,
        actressId: 7,
        libraryId: null,
        libraryIdSource: null
      }
    )
    assert.deepEqual(
      parseVideoDetailRouteContext(
        '/libraries/3/video/42/actress/7',
        new URLSearchParams('lib=9')
      ),
      {
        source: 'media-library',
        listPath: '/libraries/3',
        videoId: 42,
        actressId: 7,
        libraryId: 3,
        libraryIdSource: 'path'
      }
    )
    assert.deepEqual(
      parseVideoDetailRouteContext('/detail/42', new URLSearchParams('lib=3')),
      {
        source: 'legacy-library',
        listPath: '/',
        videoId: 42,
        libraryId: 3,
        libraryIdSource: 'query'
      }
    )
    assert.equal(
      parseVideoDetailRouteContext('/libraries/0/video/42', new URLSearchParams('lib=3')),
      null
    )
  })

  it('keeps lib only where the route needs query-owned detail scope', () => {
    assert.equal(
      canonicalizeVideoDetailLocationSearch(
        '/home/video/42',
        new URLSearchParams('q=hero&lib=003')
      ).toString(),
      'q=hero&lib=3'
    )
    assert.equal(
      canonicalizeVideoDetailLocationSearch(
        '/search/video/42',
        new URLSearchParams('q=hero&lib=bad')
      ).toString(),
      'q=hero'
    )
    assert.equal(
      canonicalizeVideoDetailLocationSearch(
        '/libraries/3/video/42',
        new URLSearchParams('q=hero&lib=9')
      ).toString(),
      'q=hero'
    )
    assert.equal(
      canonicalizeVideoDetailLocationSearch(
        '/search',
        new URLSearchParams('q=hero&lib=3')
      ).toString(),
      'q=hero'
    )
    assert.equal(
      canonicalizeVideoDetailLocationSearch(
        '/libraries/3',
        new URLSearchParams('q=hero&lib=3')
      ).toString(),
      'q=hero'
    )
  })

  it('respects a valid legacy lib hint and falls back when that membership is unavailable', async () => {
    const calls: CatalogScope[] = []
    const detail = (activeLibraryId: number): ScopedVideoDetail =>
      ({ activeLibraryId }) as ScopedVideoDetail
    const load = async (scope: CatalogScope): Promise<ScopedVideoDetail | null> => {
      calls.push(scope)
      if (scope.kind === 'library') {
        return scope.libraryId === 3 || scope.libraryId === 7
          ? detail(scope.libraryId)
          : null
      }
      return detail(2)
    }

    assert.equal((await loadLegacyDetailForRedirect(42, 3, load))?.activeLibraryId, 3)
    assert.deepEqual(calls, [{ kind: 'library', libraryId: 3 }])

    calls.length = 0
    assert.equal((await loadLegacyDetailForRedirect(42, 9, load))?.activeLibraryId, 2)
    assert.deepEqual(calls, [{ kind: 'library', libraryId: 9 }, { kind: 'all' }])

    calls.length = 0
    assert.equal((await loadLegacyDetailForRedirect(42, 9, load, 7))?.activeLibraryId, 7)
    assert.deepEqual(calls, [
      { kind: 'library', libraryId: 9 },
      { kind: 'library', libraryId: 7 }
    ])

    calls.length = 0
    assert.equal((await loadLegacyDetailForRedirect(42, null, load, 7))?.activeLibraryId, 7)
    assert.deepEqual(calls, [{ kind: 'library', libraryId: 7 }])

    calls.length = 0
    assert.equal((await loadLegacyDetailForRedirect(42, null, load, 99))?.activeLibraryId, 2)
    assert.deepEqual(calls, [{ kind: 'library', libraryId: 99 }, { kind: 'all' }])
  })
})
