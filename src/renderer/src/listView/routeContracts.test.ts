import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Location, NavigateFunction } from 'react-router-dom'
import {
  actressDetailPath,
  actressVideoActressPath,
  actressVideoDetailPath,
  parseActressVideoPath
} from './actressRoutes'
import {
  facetListPath,
  directorDetailPath,
  directorVideoDetailPath,
  organizationDetailPath,
  organizationVideoDetailPath,
  parseOrganizationPath,
  parseDirectorPath,
  parseSeriesPath,
  seriesDetailPath,
  seriesVideoDetailPath
} from './facetRoutes'
import { libraryVideoActressPath, libraryVideoDetailPath, parseLibraryVideoPath } from './libraryRoutes'
import {
  navigateToActressDetail,
  navigateToActressList,
  navigateToActressFromVideoDetail,
  navigateBackFromActressDetail,
  navigateBackFromVideoDetail,
  navigateToVideoListSurface,
  navigateToDirectorDetail,
  navigateToOrganizationDetail,
  navigateToSeriesDetail,
  navigateToVideoDetail
} from './listNavigation'
import {
  actressQueryHash,
  actressAvatarParam,
  actressStatusParam,
  LIST_PARAM,
  parseActressAvatar,
  parseActressStatus,
  classificationListQueryHash,
  parseClassificationSort,
  parseSeriesReleaseDir,
  seriesReleaseDirParam,
  patchSearchParams
} from './listQueryParams'
import {
  clearPrimaryNavigationMemory,
  forgetPrimaryListLocation,
  primaryListRoot,
  primaryNavLinkTo,
  primaryNavigationTarget,
  rememberPrimaryListLocation,
  resolvePrimaryNavTarget,
  syncPrimaryNavigationMemory
} from './primaryNavigationMemory'
import {
  parsePlaylistVideoPath,
  playlistDetailPath,
  playlistVideoDetailPath
} from './playlistRoutes'
import {
  SETTINGS_GROUPS,
  resolveSettingsRoute,
  settingsPath,
  settingsPluginDevPath
} from '../settings/settingsRoutes'
import {
  parsePendingCenterSearch,
  pendingCenterPath,
  parsePendingActressDetailPath,
  parsePendingItemKey,
  parsePendingVideoPath,
  pendingActressDetailPath,
  pendingItemKey,
  pendingVideoActressPath,
  pendingVideoDetailPath
} from './pendingRoutes'

describe('route builders and parsers', () => {
  it('round-trips library detail stacks', () => {
    assert.equal(libraryVideoDetailPath(42), '/detail/42')
    assert.equal(libraryVideoActressPath(42, 7), '/detail/42/actress/7')
    assert.deepEqual(parseLibraryVideoPath('/detail/42/actress/7'), {
      videoId: 42,
      actressId: 7
    })
  })

  it('round-trips actress detail stacks', () => {
    assert.equal(actressDetailPath(3), '/actresses/3')
    assert.equal(actressVideoDetailPath(3, 9), '/actresses/3/9')
    assert.equal(actressVideoActressPath(3, 9, 11), '/actresses/3/9/actress/11')
    assert.deepEqual(parseActressVideoPath('/actresses/3/9/actress/11'), {
      actressId: 3,
      videoId: 9,
      stackedActressId: 11
    })
  })

  it('round-trips playlist and classification entity detail stacks', () => {
    assert.equal(playlistDetailPath(4), '/playlists/4')
    assert.equal(playlistVideoDetailPath(4, 8), '/playlists/4/8')
    assert.deepEqual(parsePlaylistVideoPath('/playlists/4/8/actress/12'), {
      playlistId: 4,
      videoId: 8,
      actressId: 12
    })

    assert.equal(facetListPath('maker'), '/facet/maker')

    assert.equal(organizationDetailPath('maker', 12), '/facet/maker/o/12')
    assert.equal(organizationVideoDetailPath('publisher', 12, 5), '/facet/publisher/o/12/5')
    assert.deepEqual(parseOrganizationPath('/facet/publisher/o/12/5/actress/7'), {
      role: 'publisher',
      organizationId: 12,
      videoId: 5,
      actressId: 7
    })
    assert.equal(directorDetailPath(21), '/facet/director/d/21')
    assert.equal(directorVideoDetailPath(21, 5), '/facet/director/d/21/5')
    assert.deepEqual(parseDirectorPath('/facet/director/d/21/5/actress/7'), {
      directorId: 21,
      videoId: 5,
      actressId: 7
    })
    assert.equal(seriesDetailPath(31), '/facet/series/s/31')
    assert.equal(seriesVideoDetailPath(31, 5), '/facet/series/s/31/5')
    assert.deepEqual(parseSeriesPath('/facet/series/s/31/5/actress/7'), {
      seriesId: 31,
      videoId: 5,
      actressId: 7
    })
  })

  it('rejects malformed detail ids', () => {
    assert.equal(parseLibraryVideoPath('/detail/not-a-number'), null)
    assert.equal(parseActressVideoPath('/actresses/x'), null)
    assert.equal(parsePlaylistVideoPath('/playlists/x'), null)
  })

  it('builds pending-center locations without page-level query concatenation', () => {
    assert.equal(pendingCenterPath(), '/pending')
    assert.equal(pendingCenterPath({ type: 'all' }), '/pending')
    assert.equal(pendingCenterPath({ type: 'scan' }), '/pending?type=scan')
    assert.equal(
      pendingCenterPath({ type: 'scan', libraryId: 7 }),
      '/pending?type=scan&lib=7'
    )
    assert.equal(
      pendingCenterPath({ type: 'scrape', videoId: 42 }),
      '/pending?type=scrape&videoId=42'
    )
    assert.equal(
      pendingCenterPath({ type: 'scrape', item: pendingItemKey('scrape', 7) }),
      '/pending?type=scrape&item=scrape%3A7'
    )
    assert.equal(
      pendingCenterPath({ type: 'actress', item: pendingItemKey('actress', 'a:b') }),
      '/pending?type=actress&item=actress%3Aa%3Ab'
    )
    assert.deepEqual(parsePendingCenterSearch(new URLSearchParams('type=scrape&item=scrape:7')), {
      type: 'scrape',
      item: { domain: 'scrape', id: '7' },
      videoId: null,
      libraryId: null
    })
    // Actress ids are normalized names, so only the first separator splits the key.
    assert.deepEqual(parsePendingItemKey('actress:a:b'), { domain: 'actress', id: 'a:b' })
    assert.equal(parsePendingItemKey('unknown:1'), null)
    assert.deepEqual(parsePendingCenterSearch(new URLSearchParams('')), {
      type: 'all',
      item: null,
      videoId: null,
      libraryId: null
    })
    assert.deepEqual(parsePendingCenterSearch(new URLSearchParams('type=scan&lib=7')), {
      type: 'scan',
      item: null,
      videoId: null,
      libraryId: 7
    })
    assert.equal(pendingVideoDetailPath(42), '/pending/video/42')
    assert.equal(pendingVideoActressPath(42, 7), '/pending/video/42/actress/7')
    assert.equal(pendingActressDetailPath(8), '/pending/actress/8')
    assert.deepEqual(parsePendingActressDetailPath('/pending/actress/8'), { actressId: 8 })
    assert.equal(parsePendingActressDetailPath('/pending/video/42/actress/7'), null)
    assert.deepEqual(parsePendingVideoPath('/pending/video/42/actress/7'), {
      videoId: 42,
      actressId: 7
    })
  })
})

describe('classification list query contract', () => {
  it('accepts only video count and update time sorting with video count descending by default', () => {
    assert.deepEqual(parseClassificationSort(null, null), {
      sortBy: 'video_count',
      sortDir: 'desc'
    })
    assert.deepEqual(parseClassificationSort('updated_at', 'asc'), {
      sortBy: 'updated_at',
      sortDir: 'asc'
    })
    assert.deepEqual(parseClassificationSort('name', 'asc'), {
      sortBy: 'video_count',
      sortDir: 'asc'
    })
  })

  it('includes organization search and sorting in the shareable query identity', () => {
    assert.equal(
      classificationListQueryHash('maker', new URLSearchParams('q=studio&sort=updated_at&dir=asc')),
      'dir=asc&q=studio&sort=updated_at&type=maker'
    )
  })

  it('keeps series release sorting separate from classification-list sorting', () => {
    assert.equal(parseSeriesReleaseDir(null), 'desc')
    assert.equal(parseSeriesReleaseDir('asc'), 'asc')
    assert.equal(parseSeriesReleaseDir('invalid'), 'desc')
    assert.equal(seriesReleaseDirParam('desc'), null)
    assert.equal(seriesReleaseDirParam('asc'), 'asc')
  })
})

describe('actress avatar filter query contract', () => {
  it('normalizes avatar filter values and omits the all default', () => {
    assert.equal(parseActressAvatar('with'), 'with')
    assert.equal(parseActressAvatar('without'), 'without')
    assert.equal(parseActressAvatar('without-face'), 'without-face')
    assert.equal(parseActressAvatar('invalid'), 'all')
    assert.equal(parseActressAvatar(null), 'all')
    assert.equal(actressAvatarParam('with'), 'with')
    assert.equal(actressAvatarParam('without'), 'without')
    assert.equal(actressAvatarParam('without-face'), 'without-face')
    assert.equal(actressAvatarParam('all'), null)
  })

  it('returns to the actress list without losing its query state', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const location = {
      pathname: '/actresses/12',
      search: '?q=sara&status=failed',
      hash: '',
      state: null,
      key: 'test'
    } as Location

    navigateToActressList(navigate, location)

    assert.deepEqual(destinations, [
      { pathname: '/actresses', search: 'q=sara&status=failed' }
    ])
  })

  it('keeps avatar filters distinct in the actress query hash', () => {
    const withAvatar = new URLSearchParams(`${LIST_PARAM.avatar}=with`)
    const withoutAvatar = new URLSearchParams(`${LIST_PARAM.avatar}=without`)
    const withoutFaceAvatar = new URLSearchParams(`${LIST_PARAM.avatar}=without-face`)

    assert.notEqual(actressQueryHash(withAvatar), actressQueryHash(withoutAvatar))
    assert.notEqual(actressQueryHash(withoutAvatar), actressQueryHash(withoutFaceAvatar))
    assert.equal(actressQueryHash(new URLSearchParams()), actressQueryHash(new URLSearchParams()))
  })
})

describe('actress status filter query contract', () => {
  it('parses the canonical status values and treats anything else as all', () => {
    assert.equal(parseActressStatus('success'), 'success')
    assert.equal(parseActressStatus('unscraped'), 'unscraped')
    assert.equal(parseActressStatus('failed'), 'failed')
    assert.equal(parseActressStatus(null), 'all')
    assert.equal(parseActressStatus('all'), 'all')
    assert.equal(parseActressStatus('1'), 'all')
    assert.equal(parseActressStatus('scraped'), 'all')
  })

  it('omits the param for all and writes the canonical value otherwise', () => {
    assert.equal(actressStatusParam('all'), null)
    assert.equal(actressStatusParam('unscraped'), 'unscraped')

    const applied = patchSearchParams(new URLSearchParams('q=sara&gender=all'), {
      [LIST_PARAM.status]: actressStatusParam('failed')
    })
    assert.equal(applied.toString(), 'q=sara&gender=all&status=failed')

    const removed = patchSearchParams(applied, {
      [LIST_PARAM.status]: actressStatusParam('all')
    })
    assert.equal(removed.toString(), 'q=sara&gender=all')
  })

  it('includes status in the list query identity and ignores invalid values', () => {
    const unscraped = actressQueryHash(new URLSearchParams('status=unscraped'))
    const failed = actressQueryHash(new URLSearchParams('status=failed'))
    const invalid = actressQueryHash(new URLSearchParams('status=bogus'))
    const all = actressQueryHash(new URLSearchParams(''))

    assert.notEqual(unscraped, failed)
    assert.notEqual(unscraped, all)
    assert.equal(invalid, all)
  })

  it('keeps search, gender and sort identity while only the status changes', () => {
    const base = new URLSearchParams('q=sara&gender=all&sort=age&dir=asc')
    const withStatus = patchSearchParams(base, { [LIST_PARAM.status]: 'unscraped' })

    assert.equal(withStatus.get(LIST_PARAM.q), 'sara')
    assert.equal(withStatus.get(LIST_PARAM.gender), 'all')
    assert.equal(withStatus.get(LIST_PARAM.sort), 'age')
    assert.equal(withStatus.get(LIST_PARAM.dir), 'asc')
    assert.notEqual(actressQueryHash(withStatus), actressQueryHash(base))
  })

  it('round-trips the status query through actress detail and back', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => {
      destinations.push(to)
    }) as NavigateFunction
    const listLocation = {
      pathname: '/actresses',
      search: '?q=sara&gender=all&status=failed',
      hash: '',
      state: null,
      key: 'test'
    } as Location

    navigateToActressDetail(navigate, listLocation, 8)
    assert.deepEqual(destinations[0], {
      pathname: '/actresses/8',
      search: '?q=sara&gender=all&status=failed'
    })

    navigateToActressList(navigate, { ...listLocation, pathname: '/actresses/8' } as Location)
    assert.deepEqual(destinations[1], {
      pathname: '/actresses',
      search: 'q=sara&gender=all&status=failed'
    })
  })

  it('remembers the actress status filter across primary navigation', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/actresses/8', '?q=sara&status=unscraped&avatar=without')

    assert.deepEqual(primaryNavigationTarget('/actresses'), {
      pathname: '/actresses',
      search: '?q=sara&status=unscraped&avatar=without'
    })
  })
})

describe('primary navigation memory', () => {
  it('restores query state per list and removes unrelated nested query keys', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation(
      '/libraries/2/video/42',
      '?q=hero&status=1&resources=local,web&lib=9'
    )
    rememberPrimaryListLocation('/search/video/42', '?q=hero&libraries=2,7&lib=2')
    rememberPrimaryListLocation('/actresses/8', '?q=sara&gender=female')
    rememberPrimaryListLocation('/facet/director/d/21', '?q=miike&sort=rating')
    rememberPrimaryListLocation('/pending/video/42', '?type=scrape&item=scrape:7&videoId=42&q=drop')
    rememberPrimaryListLocation(
      '/facet/maker/o/12',
      '?q=studio&sort=updated_at&dir=asc&status=1'
    )

    assert.deepEqual(primaryNavigationTarget('/libraries/2'), {
      pathname: '/libraries/2',
      search: '?q=hero&status=1&resources=local%2Cweb'
    })
    assert.deepEqual(primaryNavigationTarget('/search'), {
      pathname: '/search',
      search: '?q=hero&libraries=2%2C7'
    })
    assert.deepEqual(primaryNavigationTarget('/actresses'), {
      pathname: '/actresses',
      search: '?q=sara&gender=female'
    })
    assert.deepEqual(primaryNavigationTarget('/facet/director'), {
      pathname: '/facet/director',
      search: '?q=miike'
    })
    assert.deepEqual(primaryNavigationTarget('/facet/maker'), {
      pathname: '/facet/maker',
      search: '?q=studio&sort=updated_at&dir=asc'
    })
    assert.deepEqual(primaryNavigationTarget('/pending'), {
      pathname: '/pending',
      search: '?type=scrape&item=scrape%3A7&videoId=42'
    })
    assert.equal(primaryListRoot('/settings/overview/status'), null)
  })

  it('persists search only when leaving a list root', () => {
    clearPrimaryNavigationMemory()
    syncPrimaryNavigationMemory('/libraries/2', '?status=1')
    syncPrimaryNavigationMemory('/libraries/2', '?status=2')
    assert.deepEqual(primaryNavigationTarget('/libraries/2'), { pathname: '/libraries/2' })

    syncPrimaryNavigationMemory('/actresses', '')
    assert.deepEqual(primaryNavigationTarget('/libraries/2'), {
      pathname: '/libraries/2',
      search: '?status=2'
    })

    syncPrimaryNavigationMemory('/settings/overview/status', '')
    assert.deepEqual(primaryNavigationTarget('/actresses'), { pathname: '/actresses' })
  })

  it('forgets a root so cross-nav no longer restores it', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/libraries/2', '?status=1&q=hero')
    forgetPrimaryListLocation('/libraries/2')
    assert.deepEqual(primaryNavigationTarget('/libraries/2'), { pathname: '/libraries/2' })
  })

  it('resolves same-section vs cross-section sidebar targets', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/libraries/2', '?status=1')

    assert.equal(resolvePrimaryNavTarget('/libraries/2', '/libraries/2', '?status=1'), null)
    assert.deepEqual(resolvePrimaryNavTarget('/libraries/2', '/libraries/2/video/9', '?status=1'), {
      pathname: '/libraries/2',
      search: '?status=1'
    })
    assert.deepEqual(resolvePrimaryNavTarget('/libraries/2', '/actresses', ''), {
      pathname: '/libraries/2',
      search: '?status=1'
    })
    assert.deepEqual(resolvePrimaryNavTarget('/actresses', '/', '?status=1'), {
      pathname: '/actresses'
    })
    assert.equal(
      resolvePrimaryNavTarget('/pending', '/pending', '?type=scrape&item=scrape:7'),
      null
    )
    assert.deepEqual(
      resolvePrimaryNavTarget('/pending', '/pending/video/42', '?type=scrape&item=scrape:7'),
      { pathname: '/pending', search: '?type=scrape&item=scrape%3A7' }
    )
  })

  it('builds nav link href from current search when active', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/libraries/2', '?status=1')

    assert.deepEqual(primaryNavLinkTo('/libraries/2', '/libraries/2', '?status=2'), {
      pathname: '/libraries/2',
      search: '?status=2'
    })
    assert.deepEqual(primaryNavLinkTo('/libraries/2', '/actresses', ''), {
      pathname: '/libraries/2',
      search: '?status=1'
    })
    assert.deepEqual(primaryNavLinkTo('/', '/actresses', ''), { pathname: '/' })
    assert.deepEqual(primaryNavLinkTo('/', '/home/video/8', '?lib=2'), { pathname: '/' })
  })
})

describe('navigation helpers', () => {
  it('keeps home, search and media-library detail stacks scoped and reversible', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction

    const home = {
      pathname: '/',
      search: '',
      hash: '',
      state: null,
      key: 'home'
    } as Location
    navigateToVideoDetail(navigate, home, 8, { libraryId: 2 })
    const homeVideo = { ...home, pathname: '/home/video/8', search: '?lib=2' } as Location
    navigateToActressFromVideoDetail(navigate, homeVideo, 8, 7)
    navigateBackFromVideoDetail(navigate, homeVideo)
    navigateToVideoListSurface(navigate, homeVideo, { tags: '3' }, { libraryId: 2 })

    const search = { ...home, pathname: '/search', search: '?q=hero&libraries=2,7' } as Location
    navigateToVideoDetail(navigate, search, 9, { libraryId: 7 })
    const searchVideo = {
      ...search,
      pathname: '/search/video/9',
      search: '?q=hero&libraries=2,7&lib=7'
    } as Location
    navigateBackFromVideoDetail(navigate, searchVideo)

    const library = { ...home, pathname: '/libraries/4', search: '?status=1' } as Location
    navigateToVideoDetail(navigate, library, 10, { libraryId: 99 })
    const libraryVideo = { ...library, pathname: '/libraries/4/video/10' } as Location
    navigateBackFromVideoDetail(navigate, libraryVideo)

    assert.deepEqual(destinations, [
      { pathname: '/home/video/8', search: 'lib=2' },
      { pathname: '/home/video/8/actress/7', search: '?lib=2' },
      { pathname: '/', search: '' },
      { pathname: '/libraries/2', search: 'tags=3' },
      { pathname: '/search/video/9', search: 'q=hero&libraries=2%2C7&lib=7' },
      { pathname: '/search', search: 'q=hero&libraries=2%2C7' },
      { pathname: '/libraries/4/video/10', search: 'status=1' },
      { pathname: '/libraries/4', search: 'status=1' }
    ])
  })

  it('closes nested actress details back to their parent video context', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const paths = [
      ['/detail/8/actress/7', '/detail/8'],
      ['/actresses/3/8/actress/7', '/actresses/3/8'],
      ['/playlists/4/8/actress/7', '/playlists/4/8'],
      ['/facet/maker/o/5/8/actress/7', '/facet/maker/o/5/8'],
      ['/facet/director/d/6/8/actress/7', '/facet/director/d/6/8'],
      ['/facet/series/s/9/8/actress/7', '/facet/series/s/9/8']
    ] as const

    for (const [pathname] of paths) {
      navigateBackFromActressDetail(navigate, {
        pathname,
        search: '?q=kept',
        hash: '',
        state: null,
        key: pathname
      })
    }

    assert.deepEqual(
      destinations,
      paths.map(([, pathname]) => ({ pathname, search: '?q=kept' }))
    )
  })

  it('keeps stable series identity and release direction through its detail stack', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const list = {
      pathname: '/facet/series',
      search: '?q=collection&sort=updated_at&dir=asc',
      hash: '',
      state: null,
      key: 's'
    } as Location
    navigateToSeriesDetail(navigate, list, 31)
    const detail = {
      ...list,
      pathname: '/facet/series/s/31',
      search: '?q=collection&sort=updated_at&dir=asc&releaseDir=asc'
    } as Location
    navigateToVideoDetail(navigate, detail, 8)
    const video = { ...detail, pathname: '/facet/series/s/31/8' } as Location
    navigateBackFromVideoDetail(navigate, video)
    assert.deepEqual(destinations, [
      { pathname: '/facet/series/s/31', search: '?q=collection&sort=updated_at&dir=asc' },
      {
        pathname: '/facet/series/s/31/8',
        search: '?q=collection&sort=updated_at&dir=asc&releaseDir=asc'
      },
      {
        pathname: '/facet/series/s/31',
        search: 'q=collection&sort=updated_at&dir=asc&releaseDir=asc'
      }
    ])
  })

  it('keeps director identity and query state through its stable detail stack', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const list = {
      pathname: '/facet/director',
      search: '?q=lee',
      hash: '',
      state: null,
      key: 'd'
    } as Location
    navigateToDirectorDetail(navigate, list, 21)
    const detail = { ...list, pathname: '/facet/director/d/21' } as Location
    navigateToVideoDetail(navigate, detail, 8)
    const video = { ...list, pathname: '/facet/director/d/21/8' } as Location
    navigateBackFromVideoDetail(navigate, video)
    assert.deepEqual(destinations, [
      { pathname: '/facet/director/d/21', search: '?q=lee' },
      { pathname: '/facet/director/d/21/8', search: '?q=lee' },
      { pathname: '/facet/director/d/21', search: 'q=lee' }
    ])
  })

  it('opens an organization by stable id while preserving its role-list query', () => {
    let destination: unknown
    const navigate = ((to: unknown) => {
      destination = to
    }) as NavigateFunction
    const location = {
      pathname: '/facet/maker',
      search: '?q=studio&sort=updated_at&dir=asc',
      hash: '',
      state: null,
      key: 'test'
    } as Location

    navigateToOrganizationDetail(navigate, location, 'maker', 12)
    assert.deepEqual(destination, {
      pathname: '/facet/maker/o/12',
      search: '?q=studio&sort=updated_at&dir=asc'
    })
  })

  it('keeps classification query only inside the same classification stack', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const search = '?q=kept&sort=updated_at&dir=asc'

    navigateToOrganizationDetail(
      navigate,
      { pathname: '/facet/maker/o/1/8', search, hash: '', state: null, key: 'maker' },
      'maker',
      2
    )
    navigateToDirectorDetail(
      navigate,
      { pathname: '/facet/director/d/1/8', search, hash: '', state: null, key: 'director' },
      2
    )
    navigateToOrganizationDetail(
      navigate,
      { pathname: '/facet/publisher/o/1/8', search, hash: '', state: null, key: 'cross' },
      'maker',
      2
    )

    assert.deepEqual(destinations, [
      { pathname: '/facet/maker/o/2', search },
      { pathname: '/facet/director/d/2', search },
      { pathname: '/facet/maker/o/2', search: '' }
    ])
  })

  it('keeps video and actress navigation inside the stable organization stack', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => {
      destinations.push(to)
    }) as NavigateFunction
    const detailLocation = {
      pathname: '/facet/publisher/o/12',
      search: '?q=studio&sort=updated_at&dir=asc',
      hash: '',
      state: null,
      key: 'organization'
    } as Location

    navigateToVideoDetail(navigate, detailLocation, 42)
    const videoLocation = {
      ...detailLocation,
      pathname: '/facet/publisher/o/12/42'
    } as Location
    navigateToActressFromVideoDetail(navigate, videoLocation, 42, 7)
    navigateBackFromVideoDetail(navigate, videoLocation)

    assert.deepEqual(destinations, [
      {
        pathname: '/facet/publisher/o/12/42',
        search: '?q=studio&sort=updated_at&dir=asc'
      },
      {
        pathname: '/facet/publisher/o/12/42/actress/7',
        search: '?q=studio&sort=updated_at&dir=asc'
      },
      {
        pathname: '/facet/publisher/o/12',
        search: 'q=studio&sort=updated_at&dir=asc'
      }
    ])
  })

  it('keeps video and actress navigation inside the pending workbench stack', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const pending = {
      pathname: '/pending',
      search: '?tab=scrape&id=7&videoId=42',
      hash: '',
      state: null,
      key: 'pending'
    } as Location

    navigateToVideoDetail(navigate, pending, 42)
    const video = { ...pending, pathname: '/pending/video/42' } as Location
    navigateToActressFromVideoDetail(navigate, video, 42, 9)
    const actress = { ...pending, pathname: '/pending/video/42/actress/9' } as Location
    navigateBackFromActressDetail(navigate, actress)
    navigateBackFromVideoDetail(navigate, video)

    assert.deepEqual(destinations, [
      { pathname: '/pending/video/42', search: pending.search },
      { pathname: '/pending/video/42/actress/9', search: pending.search },
      { pathname: '/pending/video/42', search: pending.search },
      { pathname: '/pending', search: 'tab=scrape&id=7&videoId=42' }
    ])
  })

  it('opens actress detail from the pending inbox and returns to it', () => {
    const destinations: unknown[] = []
    const navigate = ((to: unknown) => destinations.push(to)) as NavigateFunction
    const pending = {
      pathname: '/pending',
      search: '?type=actress&item=actress%3Aname',
      hash: '',
      state: null,
      key: 'pending-actress'
    } as Location

    navigateToActressDetail(navigate, pending, 8)
    const overlay = { ...pending, pathname: '/pending/actress/8' } as Location
    navigateBackFromActressDetail(navigate, overlay)

    assert.deepEqual(destinations, [
      { pathname: '/pending/actress/8', search: pending.search },
      { pathname: '/pending', search: pending.search }
    ])
  })

})

describe('settings route contract', () => {
  it('builds canonical settings paths and resolves valid sections', () => {
    assert.equal(settingsPath('overview'), '/settings/overview/status')
    assert.equal(settingsPath('library'), '/settings/library/sources')
    assert.equal(settingsPath('network'), '/settings/network/proxy')
    assert.deepEqual(SETTINGS_GROUPS.slice(0, 2).map((group) => group.id), [
      'overview',
      'library'
    ])
    assert.deepEqual(SETTINGS_GROUPS[1].tabs[0], {
      id: 'sources',
      label: '来源与扫描'
    })
    assert.equal(settingsPluginDevPath(), '/settings/plugin-dev')
    assert.deepEqual(resolveSettingsRoute('/settings/library/paths'), {
      group: SETTINGS_GROUPS[1],
      tab: 'sources'
    })
    assert.deepEqual(resolveSettingsRoute('/settings/library/scan'), {
      group: SETTINGS_GROUPS[1],
      tab: 'sources'
    })
    assert.deepEqual(resolveSettingsRoute('/settings/network/proxy'), {
      group: {
        id: 'network',
        label: '网络',
        hint: '代理连接',
        description: '刮削与 LLM 请求的 HTTP/HTTPS 代理设置。',
        defaultTab: 'proxy',
        tabs: [{ id: 'proxy', label: '代理' }]
      },
      tab: 'proxy'
    })
  })
})
