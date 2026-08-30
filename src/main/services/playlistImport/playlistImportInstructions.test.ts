import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PLAYLIST_IMPORTER_SYSTEM_PROMPT } from './playlistImportInstructions'

describe('playlist importer browser guidance', () => {
  it('prefers structured reads and keeps state-changing navigation host-owned', () => {
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /页面读取优先使用 snapshot、find 和 html/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /只有.*才使用 evaluate/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /只允许.*只读动作/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /不要尝试 open、click 或 scroll/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /候选枚举交给宿主 selector 检查点/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /不得手工抄写候选数组/)
  })

  it('extracts a first-page playlist name only from reliable page evidence', () => {
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /首个清单页.*suggestedPlaylistName/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /清单主标题.*metadata\/document title/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /不得根据影片内容、URL 或用户名编造名称/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /没有可靠名称时省略/)
    assert.match(PLAYLIST_IMPORTER_SYSTEM_PROMPT, /首个清单页.*提交 suggestedPlaylistName/)
  })
})
