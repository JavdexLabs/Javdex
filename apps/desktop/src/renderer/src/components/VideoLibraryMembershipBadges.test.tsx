import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import TestRenderer from 'react-test-renderer'
import type { MediaLibraryBadge } from '@shared/catalogTypes'
import VideoLibraryMembershipBadges from './VideoLibraryMembershipBadges'

Object.defineProperty(globalThis, 'React', {
  configurable: true,
  value: React
})

function library(libraryId: number, name: string): MediaLibraryBadge {
  return { libraryId, name, icon: 'library', color: 'slate' }
}

describe('VideoLibraryMembershipBadges', () => {
  it('puts the active resource scope first and names the other memberships accessibly', () => {
    const renderer = TestRenderer.create(
      <VideoLibraryMembershipBadges
        onSelectLibrary={() => {}}
        activeLibraryId={2}
        libraries={[library(1, '主库'), library(2, '收藏库'), library(3, '离线库')]}
      />
    )

    const root = renderer.root.findByProps({
      'aria-label': '当前媒体库：收藏库；其它媒体库：主库、离线库'
    })
    const badges = root.findAll((node) => node.props['data-library-id'] != null)
    assert.equal(badges[0]?.props.title, '收藏库（当前资源）')
    assert.equal(badges[0]?.props['data-current'], true)
    assert.equal(badges[1]?.props.title, '主库')
    renderer.unmount()
  })

  it('keeps every library selectable, including memberships after the third', () => {
    const selected: number[] = []
    const renderer = TestRenderer.create(
      <VideoLibraryMembershipBadges
        onSelectLibrary={(id) => selected.push(id)}
        activeLibraryId={4}
        libraries={[
          library(1, '一'),
          library(2, '二'),
          library(3, '三'),
          library(4, '四'),
          library(5, '五')
        ]}
      />
    )

    const badges = renderer.root.findAll((node) => node.props['data-library-id'] != null)
    assert.equal(badges.length, 5)
    assert.equal(badges[0]?.props.title, '四（当前资源）')
    badges[0].props.onClick()
    badges[4].props.onClick()
    assert.deepEqual(selected, [5])
    assert.equal(badges[0].props['aria-pressed'], true)
    assert.equal(badges[4].type, 'button')
    renderer.unmount()
  })
})
