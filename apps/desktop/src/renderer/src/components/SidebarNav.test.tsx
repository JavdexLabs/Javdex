import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { SidebarNavIcon, SidebarNavLabel, SidebarNavLink, SidebarNavRow } from './SidebarNav'
import { NavIcon } from './NavIcons'
import AppBrand from './AppBrand'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })

test('sidebar navigation forwards native route, click, ref and presentation slots', () => {
  let clicks = 0
  const ref = React.createRef<HTMLAnchorElement>()
  const anchor = { focus() {} }
  act(() => { renderer = TestRenderer.create(<MemoryRouter initialEntries={['/libraries/3/video/1']}>
    <SidebarNavRow className="caller-row"><SidebarNavLink ref={ref} to="/libraries/3?q=ABC"
      active reserveBadgeSpace title="媒体库" draggable={false} className="caller-link"
      onClick={event => { event.preventDefault(); clicks++ }}>
      <SidebarNavIcon className="caller-icon" style={{ color: 'red' }}><NavIcon name="film" /></SidebarNavIcon>
      <SidebarNavLabel className="caller-label">当前媒体库</SidebarNavLabel>
    </SidebarNavLink><button>待确认</button></SidebarNavRow>
  </MemoryRouter>, { createNodeMock: node => node.type === 'a' ? anchor : null }) })
  const link = renderer!.root.findByType('a')
  assert.equal(ref.current, anchor)
  assert.equal(link.props.href, '/libraries/3?q=ABC')
  assert.equal(link.props.draggable, false)
  assert.equal(link.props.title, '媒体库')
  assert.equal(link.props['aria-current'], 'page')
  assert.equal(link.props['data-with-badge'], true)
  assert.match(link.props.className, /(?:^| )caller-link(?: |$)/)
  const event = { preventDefault() { this.defaultPrevented = true }, defaultPrevented: false }
  link.props.onClick(event)
  assert.equal(clicks, 1)
  assert.equal(renderer!.root.findByType('svg').props['aria-hidden'], true)
  assert.equal(renderer!.root.findByType('svg').props.width, 18)
  assert.deepEqual(renderer!.root.findByType(SidebarNavIcon).props.style, { color: 'red' })
})

test('sidebar native matching and caller-active presentation remain distinct', () => {
  act(() => { renderer = TestRenderer.create(<MemoryRouter initialEntries={['/home/video/1']}>
    <SidebarNavLink to="/" end active>首页</SidebarNavLink>
    <SidebarNavLink to="/playlists">清单</SidebarNavLink>
  </MemoryRouter>) })
  const [home, playlists] = renderer!.root.findAllByType('a')
  assert.equal(home.props['aria-current'], undefined)
  assert.match(home.props.className, /(?:^| )active(?: |$)/)
  assert.doesNotMatch(playlists.props.className, /(?:^| )active(?: |$)/)
  assert.equal(playlists.props['data-with-badge'], undefined)
  assert.equal(renderer!.root.findAllByType('button').length, 0)
})

test('brand and navigation glyphs own presentation without the legacy chrome classes', () => {
  act(() => { renderer = TestRenderer.create(<><AppBrand /><NavIcon name="pending" /></>) })
  const brand = renderer!.root.findByProps({ 'aria-label': 'Javdex' })
  assert.equal(brand.findByProps({ 'aria-hidden': 'true' }).findAllByType('span').slice(1).map(span => span.children.join('')).join(''), 'Javdex')
  for (const node of renderer!.root.findAll(node => typeof node.type === 'string' && typeof node.props.className === 'string')) {
    assert.doesNotMatch(node.props.className, /(?:^| )(?:brand(?:-[\w-]+)?|nav-svg)(?: |$)/)
  }
})
