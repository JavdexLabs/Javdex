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
  facetVideoDetailPath,
  facetVideoListPath,
  parseFacetVideoPath
} from './facetRoutes'
import { libraryVideoActressPath, libraryVideoDetailPath, parseLibraryVideoPath } from './libraryRoutes'
import { navigateToFacetDetail } from './listNavigation'
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
import { resolveSettingsRoute, settingsPath, settingsPluginDevPath } from '../settings/settingsRoutes'

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

  it('round-trips playlist and facet detail stacks', () => {
    assert.equal(playlistDetailPath(4), '/playlists/4')
    assert.equal(playlistVideoDetailPath(4, 8), '/playlists/4/8')
    assert.deepEqual(parsePlaylistVideoPath('/playlists/4/8/actress/12'), {
      playlistId: 4,
      videoId: 8,
      actressId: 12
    })

    assert.equal(facetListPath('maker'), '/facet/maker')
    assert.equal(facetVideoListPath('maker', 'A B'), '/facet/maker/v/A%20B')
    assert.equal(facetVideoDetailPath('maker', 'A B', 5), '/facet/maker/v/A%20B/5')
    assert.deepEqual(parseFacetVideoPath('/facet/maker/v/A%20B/5/actress/7'), {
      facetType: 'maker',
      valueKey: 'A%20B',
      videoId: 5,
      actressId: 7
    })
  })

  it('rejects malformed detail ids', () => {
    assert.equal(parseLibraryVideoPath('/detail/not-a-number'), null)
    assert.equal(parseActressVideoPath('/actresses/x'), null)
    assert.equal(parsePlaylistVideoPath('/playlists/x'), null)
  })
})

describe('primary navigation memory', () => {
  it('restores query state per list and removes unrelated nested query keys', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/detail/42', '?q=hero&status=1')
    rememberPrimaryListLocation('/actresses/8', '?q=sara&gender=female')
    rememberPrimaryListLocation('/facet/director/v/Test', '?q=miike&sort=rating')

    assert.deepEqual(primaryNavigationTarget('/'), {
      pathname: '/',
      search: '?q=hero&status=1'
    })
    assert.deepEqual(primaryNavigationTarget('/actresses'), {
      pathname: '/actresses',
      search: '?q=sara&gender=female'
    })
    assert.deepEqual(primaryNavigationTarget('/facet/director'), {
      pathname: '/facet/director',
      search: '?q=miike'
    })
    assert.equal(primaryListRoot('/settings/overview/status'), null)
  })

  it('persists search only when leaving a list root', () => {
    clearPrimaryNavigationMemory()
    syncPrimaryNavigationMemory('/', '?status=1')
    syncPrimaryNavigationMemory('/', '?status=2')
    assert.deepEqual(primaryNavigationTarget('/'), { pathname: '/' })

    syncPrimaryNavigationMemory('/actresses', '')
    assert.deepEqual(primaryNavigationTarget('/'), {
      pathname: '/',
      search: '?status=2'
    })

    syncPrimaryNavigationMemory('/settings/overview/status', '')
    assert.deepEqual(primaryNavigationTarget('/actresses'), { pathname: '/actresses' })
  })

  it('forgets a root so cross-nav no longer restores it', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/', '?status=1&q=hero')
    forgetPrimaryListLocation('/')
    assert.deepEqual(primaryNavigationTarget('/'), { pathname: '/' })
  })

  it('resolves same-section vs cross-section sidebar targets', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/', '?status=1')

    assert.equal(resolvePrimaryNavTarget('/', '/', '?status=1'), null)
    assert.deepEqual(resolvePrimaryNavTarget('/', '/detail/9', '?status=1'), {
      pathname: '/',
      search: '?status=1'
    })
    assert.deepEqual(resolvePrimaryNavTarget('/', '/actresses', ''), {
      pathname: '/',
      search: '?status=1'
    })
    assert.deepEqual(resolvePrimaryNavTarget('/actresses', '/', '?status=1'), {
      pathname: '/actresses'
    })
  })

  it('builds nav link href from current search when active', () => {
    clearPrimaryNavigationMemory()
    rememberPrimaryListLocation('/', '?status=9')

    assert.deepEqual(primaryNavLinkTo('/', '/', '?status=1'), {
      pathname: '/',
      search: '?status=1'
    })
    assert.deepEqual(primaryNavLinkTo('/', '/actresses', ''), {
      pathname: '/',
      search: '?status=9'
    })
  })
})

describe('navigation helpers', () => {
  it('preserves the parent facet query when opening its detail', () => {
    let destination: unknown
    const navigate = ((to: unknown) => {
      destination = to
    }) as NavigateFunction
    const location = {
      pathname: '/facet/director',
      search: '?q=miike',
      hash: '',
      state: null,
      key: 'test'
    } as Location

    navigateToFacetDetail(navigate, location, 'director', 'Takashi Miike')
    assert.deepEqual(destination, {
      pathname: '/facet/director/v/Takashi%20Miike',
      search: '?q=miike'
    })
  })

  it('clears library search when opening a facet from video detail', () => {
    let destination: unknown
    const navigate = ((to: unknown) => {
      destination = to
    }) as NavigateFunction
    const location = {
      pathname: '/detail/42',
      search: '?q=hero&tags=1,2&status=1&year=2024&sort=rating&dir=asc',
      hash: '',
      state: null,
      key: 'test'
    } as Location

    navigateToFacetDetail(navigate, location, 'maker', 'S1')
    assert.deepEqual(destination, {
      pathname: '/facet/maker/v/S1',
      search: ''
    })
  })
})

describe('settings route contract', () => {
  it('builds canonical settings paths and resolves valid sections', () => {
    assert.equal(settingsPath('overview'), '/settings/overview/status')
    assert.equal(settingsPath('network'), '/settings/network/proxy')
    assert.equal(settingsPluginDevPath(), '/settings/plugin-dev')
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
