import { readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const source = readFileSync(path.resolve('src/renderer/src/pages/DetailPage.tsx'), 'utf8')

describe('video detail section order', () => {
  it('renders a titled related-links section after video resources', () => {
    const resourcesIndex = source.indexOf('<VideoDetailSecondaryMeta')
    const linksSectionIndex = source.indexOf(
      '<section className="detail-section detail-section--links">'
    )
    const samplesIndex = source.indexOf('<VideoSampleGallery')

    assert.ok(resourcesIndex >= 0, 'expected the video resources section')
    assert.ok(linksSectionIndex > resourcesIndex, 'related links should follow video resources')
    assert.ok(samplesIndex > linksSectionIndex, 'related links should precede the sample gallery')

    const linksSection = source.slice(linksSectionIndex, samplesIndex)
    assert.match(linksSection, /<h2 className="section-title">相关链接<\/h2>/)
    assert.match(linksSection, /<RelatedLinksList links=\{video\.links \?\? \[\]\} \/>/)
  })
})
