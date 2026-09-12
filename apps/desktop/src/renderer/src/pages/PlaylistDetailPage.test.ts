import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const source = readFileSync(path.resolve('apps/desktop/src/renderer/src/pages/PlaylistDetailPage.tsx'), 'utf8')

describe('PlaylistDetailPage resource filter feedback', () => {
  it('keeps the compact toolbar count without rendering an applied-filter bar', () => {
    assert.match(source, /资源筛选\{resourceFilters\.length > 0 \? ` · \$\{resourceFilters\.length\}` : ''\}/)
    assert.doesNotMatch(source, /AppliedFilterBar/)
  })

  it('uses an import action icon instead of a download icon', () => {
    assert.match(source, /icon: <Import \{\.\.\.UI_ICON\} \/>/)
    assert.doesNotMatch(source, /icon: <Download /)
  })
})
