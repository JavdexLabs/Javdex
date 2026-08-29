import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'
import VideoDeleteImpact from './VideoDeleteImpact'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

describe('VideoDeleteImpact', () => {
  it('shows every affected domain without a duplicate source-file section', () => {
    const impact: VideoLifecycleImpact = {
      kind: 'delete-globally',
      revision: 'rev',
      videoId: 91,
      sourceLibraryId: null,
      targetLibraryId: null,
      resourceIds: [1, 2],
      sourcePaths: ['/media/ML-091.mp4', '/media/ML-091.strm'],
      remainingLibraryIds: [],
      removesCanonicalVideo: true,
      playlistCount: 1,
      assetCount: 1,
      libraries: [
        { libraryId: 1, name: '主库', status: 'active', resourceCount: 1 },
        { libraryId: 2, name: '归档库', status: 'archived', resourceCount: 1 }
      ],
      resources: [
        {
          resourceId: 1,
          libraryId: 1,
          kind: 'local',
          displayName: 'ML-091.mp4',
          displayLocator: '/media/ML-091.mp4',
          isPrimary: true,
          sourceFilePath: '/media/ML-091.mp4'
        },
        {
          resourceId: 2,
          libraryId: 2,
          kind: 'web',
          displayName: null,
          displayLocator: 'example.com / ML-091',
          isPrimary: false,
          sourceFilePath: '/media/ML-091.strm'
        }
      ],
      playlists: [{ playlistId: 3, name: '稍后观看' }],
      mediaAssets: [{ assetId: null, type: 'cover', localPath: 'covers/ML-091.jpg' }],
      pendingScrapeCount: 1,
      pendingAgentDraftCount: 2,
      pendingStagingAssetCount: 3,
      sourceFilesPreserved: false
    }

    const markup = renderToStaticMarkup(<VideoDeleteImpact impact={impact} />)

    for (const expected of [
      '主库',
      '归档库',
      'ML-091.mp4',
      'example.com / ML-091',
      '稍后观看',
      'covers/ML-091.jpg',
      'Agent 草稿 2 项',
      '本地视频 / STRM 源文件',
      '/media/ML-091.mp4',
      '/media/ML-091.strm'
    ]) {
      assert.match(markup, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    assert.doesNotMatch(markup, /将删除磁盘源文件|磁盘源文件会保留/)
  })
})
