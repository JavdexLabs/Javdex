import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CatalogBackend } from '../application/catalogBackend'
import { resolveRemoteScrapeFields } from './catalogRemoteScrape'

describe('catalog remote scrape field selection', () => {
  it('uses authoritative image and source facts rather than detail DTO guesses', async () => {
    const calls: unknown[] = []
    const backend = {
      queries: {
        resolveScrapeFields: async (input: { kind: string }) => {
          calls.push(input)
          return { fields: input.kind === 'actress' ? ['avatar'] : ['source'] }
        }
      }
    } as unknown as CatalogBackend
    assert.deepEqual(await resolveRemoteScrapeFields(backend, {
      kind: 'actress', id: 1, fields: ['avatar', 'nameZh']
    }), ['avatar'])
    assert.deepEqual(await resolveRemoteScrapeFields(backend, {
      kind: 'video', id: 2, fields: ['title', 'source'], sourceName: 'Site'
    }), ['source'])
    assert.equal(calls.length, 2)
  })

  it('does not turn invalid responses or request failures into empty fields', async () => {
    const backend = {
      queries: { resolveScrapeFields: async () => ({ fields: ['not-requested'] }) }
    } as unknown as CatalogBackend
    await assert.rejects(resolveRemoteScrapeFields(backend, {
      kind: 'actress', id: 1, fields: ['avatar']
    }), /响应无效/)
    backend.queries.resolveScrapeFields = async () => { throw new Error('unavailable') }
    await assert.rejects(resolveRemoteScrapeFields(backend, {
      kind: 'actress', id: 1, fields: ['avatar']
    }), /unavailable/)
  })
})
