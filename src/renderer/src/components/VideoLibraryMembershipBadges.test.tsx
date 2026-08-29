import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import TestRenderer from 'react-test-renderer'
import type { MediaLibraryBadge } from '@shared/catalogTypes'
import VideoLibraryMembershipBadges from './VideoLibraryMembershipBadges'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

function library(libraryId: number, name: string): MediaLibraryBadge {
  return { libraryId, name, icon: 'library', color: 'slate' }
}

describe('VideoLibraryMembershipBadges', () => {
  it('puts the active resource scope first and names the other memberships accessibly', () => {
    const renderer = TestRenderer.create(
      <VideoLibraryMembershipBadges
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

  it('bounds the visible badges and exposes hidden library names in the overflow title', () => {
    const renderer = TestRenderer.create(
      <VideoLibraryMembershipBadges
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
    assert.equal(badges.length, 3)
    assert.equal(badges[0]?.props.title, '四（当前资源）')
    const overflow = renderer.root.find((node) => node.props.title === '三、五')
    assert.equal(overflow.children.join(''), '+2')
    renderer.unmount()
  })
})
