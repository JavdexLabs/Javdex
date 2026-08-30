import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { declarationsFor } from '../../test/cssDeclarations'

const sourcePath = 'src/renderer/src/components/playlistImport/PlaylistImportContext.tsx'
const identityReviewPath = 'src/renderer/src/components/playlistImport/PlaylistImportIdentityReview.tsx'
const cssPath = 'src/renderer/src/components/playlistImport/PlaylistImportContext.module.css'

describe('PlaylistImportProvider workspace', () => {
  it('uses the Agent scrape two-pane workspace with live activity and result preview', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /<AgentWorkspaceModal/)
    assert.match(source, /<AgentWorkspacePane label="Agent 运行">/)
    assert.match(source, /<AgentMetadataActivityFeed/)
    assert.match(source, /<AgentWorkspacePane label="结果预览">/)
    assert.match(source, /snapshot\.preview\.items\.map/)
    assert.match(source, /<PlaylistImportIdentityReview/)
  })

  it('offers one confirmed termination action in running and waiting-user footers', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /const terminationAction/)
    assert.match(source, /setCancelConfirmation\(true\)/)
    assert.equal(source.match(/\{terminationAction\}/g)?.length, 3)
    assert.doesNotMatch(source, /后台运行/)
    assert.doesNotMatch(source, /api\.playlistImport\.snapshot\(\)/)
    assert.match(source, /<ConfirmModal/)
    assert.match(source, /title="终止外部清单导入？"/)
    assert.match(source, /confirmText="终止任务"/)
  })

  it('closes the import workspace after the host confirms task termination', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')
    const cancelFlow = source.slice(
      source.indexOf('const cancel = async'),
      source.indexOf('const resolveIdentities = async')
    )

    assert.match(
      cancelFlow,
      /await api\.playlistImport\.control[\s\S]*?setSnapshot\(next\)[\s\S]*?currentRunId\.current = null[\s\S]*?setVisible\(false\)/
    )
    assert.doesNotMatch(
      cancelFlow.slice(cancelFlow.indexOf('catch (cancelError)')),
      /setVisible\(false\)/
    )
  })

  it('closes only through the actions rendered inside the import dialog', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')
    const importDialog = source.slice(
      source.indexOf('<AgentWorkspaceModal'),
      source.indexOf('<ConfirmModal')
    )

    assert.match(importDialog, /title="导入外部清单"/)
    assert.match(importDialog, /dismissible=\{false\}/)
    assert.doesNotMatch(importDialog, /dismissible=\{!busy\}/)
  })

  it('closes the import dialog before navigating to the imported playlist', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(
      source,
      /onClick=\{\(\) => \{\s*setVisible\(false\)\s*navigate\(`\/playlists\/\$\{snapshot\.outcome\?\.playlistId\}`\)\s*\}\}[\s\S]*?查看清单/
    )
  })

  it('offers frozen write options with source-playlist linking disabled by default', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /const \[autoCreateUnmatchedVideos, setAutoCreateUnmatchedVideos\] = useState\(true\)/)
    assert.match(source, /const \[saveDetailLinks, setSaveDetailLinks\] = useState\(true\)/)
    assert.match(source, /const \[saveSourcePlaylistLink, setSaveSourcePlaylistLink\] = useState\(false\)/)
    assert.match(source, /title="自动创建无资源影片"/)
    assert.match(source, /关闭后跳过这些条目/)
    assert.match(source, /title="保存详情页到相关链接"/)
    assert.match(source, /已存在的链接不会重复添加/)
    assert.match(source, /title="保存来源清单链接"/)
    assert.match(source, /开启后，将本次外部清单页保存到目标清单的“相关链接”/)
    assert.match(source, /targetLibraryId: Number\(targetLibraryId\),\s*autoCreateUnmatchedVideos,\s*saveDetailLinks,\s*saveSourcePlaylistLink,/)
  })

  it('selects the active default media library when opening the importer', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /const activeLibraries = nextLibraries\.filter\(\(library\) => library\.status === 'active'\)/)
    assert.match(
      source,
      /setTargetLibraryId\(\s*activeLibraries\.find\(\(library\) => library\.isDefault\)\?\.id\.toString\(\) \?\? ''\s*\)/
    )
  })

  it('explains the Agent name and host-date fallback for an empty new-playlist name', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /留空时由 Agent 从页面名称生成/)
    assert.match(source, /未识别到时使用站点域名和日期/)
  })

  it('invalidates global video projections and discards stale identity choices', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    assert.match(source, /invalidateVideoLibraryQueries\(queryClient\)/)
    assert.match(source, /identityReviewChoiceKey/)
    assert.match(source, /itemRevision: item\.itemRevision/)
    assert.match(source, /candidateIds: item\.candidates\.map/)
    assert.match(source, /setChoices\(\{\}\)/)
  })

  it('broadcasts completion so recovered imports refresh mounted playlist surfaces', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')
    const listPage = readFileSync(path.resolve('src/renderer/src/pages/PlaylistsPage.tsx'), 'utf8')
    const detailPage = readFileSync(path.resolve('src/renderer/src/pages/PlaylistDetailPage.tsx'), 'utf8')

    assert.match(source, /notifyPlaylistImportCompleted\(outcome\.playlistId\)/)
    assert.match(listPage, /onPlaylistImportCompleted[\s\S]*?void loadList\(\)/)
    assert.match(detailPage, /completedPlaylistId === playlistId[\s\S]*?void loadDetail\(\)/)
    assert.doesNotMatch(`${listPage}\n${detailPage}`, /onCompleted:/)
  })

  it('renders the complete release summary instead of only aggregate reuse counts', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')

    for (const field of [
      'pagesRead',
      'sourceItems',
      'uniqueDetailUrls',
      'directReuses',
      'detailReuses',
      'userSelectedReuses',
      'crossLibraryReuses',
      'targetLibraryMembersCreated',
      'externalDuplicateItems',
      'convergedExternalItems',
      'reuseLibraryDistribution'
    ]) {
      assert.match(source, new RegExp(`snapshot\\.outcome\\.${field}`))
    }
  })

  it('keeps preview rows dense and long text truncation stable', () => {
    const row = declarationsFor(cssPath, '.previewRow')
    const title = declarationsFor(cssPath, '.previewTitle')

    assert.equal(row.get('display'), 'grid')
    assert.equal(row.get('min-width'), '0')
    assert.equal(title.get('overflow'), 'hidden')
    assert.equal(title.get('text-overflow'), 'ellipsis')
    assert.equal(title.get('white-space'), 'nowrap')
  })

  it('shows enough candidate identity evidence and opens links through the app shell', () => {
    const source = readFileSync(path.resolve(sourcePath), 'utf8')
    const identityReview = readFileSync(path.resolve(identityReviewPath), 'utf8')

    assert.match(identityReview, /candidate\.publisher/)
    assert.match(identityReview, /candidate\.releaseDate/)
    assert.match(identityReview, /candidate\.libraryNames/)
    assert.match(identityReview, /candidate\.resourceKinds/)
    assert.match(identityReview, /candidate\.relatedLinks/)
    assert.match(identityReview, /onOpenExternalLink/)
    assert.match(source, /openExternalLink/)
    assert.doesNotMatch(`${source}\n${identityReview}`, /target="_blank"/)
  })
})
