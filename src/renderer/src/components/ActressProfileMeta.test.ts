import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildActressScrapeMetaItems, canMarkActressScrapeSuccess } from './ActressProfileMeta'

describe('ActressProfileMeta scrape record', () => {
  it('shows all cumulative states and only includes a non-blank success time', () => {
    assert.deepEqual(
      buildActressScrapeMetaItems({ scraped_status: 0, last_scraped_at: null }),
      [{ key: 'scraped_status', label: '刮削状态', value: '未刮削', status: 0 }]
    )
    assert.deepEqual(
      buildActressScrapeMetaItems({ scraped_status: 1, last_scraped_at: 'stored timestamp' }),
      [
        { key: 'scraped_status', label: '刮削状态', value: '刮削成功', status: 1 },
        { key: 'last_scraped_at', label: '最近成功', value: 'stored timestamp' }
      ]
    )
    assert.deepEqual(
      buildActressScrapeMetaItems({ scraped_status: 2, last_scraped_at: '   ' }),
      [{ key: 'scraped_status', label: '刮削状态', value: '刮削失败', status: 2 }]
    )
  })

  it('offers the manual success mark only for unscraped and failed records', () => {
    assert.equal(canMarkActressScrapeSuccess(0), true)
    assert.equal(canMarkActressScrapeSuccess(2), true)
    assert.equal(canMarkActressScrapeSuccess(1), false)
  })
})
