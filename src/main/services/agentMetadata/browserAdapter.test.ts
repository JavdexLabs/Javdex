import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertAgentMetadataPublicHttpUrl } from './browserAdapter'

describe('Agent metadata browser URL policy', () => {
  it('allows a public hostname when a system proxy maps it to the RFC 2544 fake-IP range', async () => {
    const url = await assertAgentMetadataPublicHttpUrl(
      'https://www.javlibrary.com/cn/javli43h2m.html',
      async () => [{ address: '198.18.0.22' }]
    )

    assert.equal(url.hostname, 'www.javlibrary.com')
  })

  it('still rejects direct benchmark-range IPs and hostnames resolving to private networks', async () => {
    await assert.rejects(
      assertAgentMetadataPublicHttpUrl('https://198.18.0.22/detail'),
      /不允许访问本机或局域网地址/
    )
    await assert.rejects(
      assertAgentMetadataPublicHttpUrl(
        'https://public-looking.example/detail',
        async () => [{ address: '192.168.1.20' }]
      ),
      /不允许访问本机或局域网地址/
    )
  })
})
