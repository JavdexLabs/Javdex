import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPluginRegistry, runCompositeFieldGroups } from './compositeScrapeRun'

type Field = 'title' | 'cover' | 'maker'
type Result = { title?: string; cover?: string; maker?: string }

describe('buildPluginRegistry', () => {
  it('lets user scrapers override bundled names', () => {
    const registry = buildPluginRegistry(
      () => [{ scraperName: 'A', source: 'user' }],
      () => [
        { scraperName: 'A', source: 'bundled' },
        { scraperName: 'B', source: 'bundled' }
      ]
    )
    assert.equal(registry.get('A')?.source, 'user')
    assert.equal(registry.get('B')?.source, 'bundled')
  })
})

describe('runCompositeFieldGroups', () => {
  const fieldPluginMap: Partial<Record<Field, string>> = {
    title: 'Alpha',
    cover: 'Beta',
    maker: 'Alpha'
  }

  it('groups fields, picks, and merges across plugins', async () => {
    const calls: string[] = []
    const outcome = await runCompositeFieldGroups<Field, Result>({
      fieldPluginMap,
      fields: ['title', 'cover', 'maker'],
      onPluginError: 'abort',
      runPlugin: async (pluginName, fields) => {
        calls.push(`${pluginName}:${fields.join(',')}`)
        if (pluginName === 'Alpha') return { title: 'T', maker: 'M' }
        return { cover: 'C' }
      },
      pick: (result, fields) => {
        const out: Result = {}
        if (fields.includes('title')) out.title = result.title
        if (fields.includes('cover')) out.cover = result.cover
        if (fields.includes('maker')) out.maker = result.maker
        return out
      },
      merge: (base, next) => ({ ...(base ?? {}), ...next })
    })

    assert.deepEqual(calls, ['Alpha:title,maker', 'Beta:cover'])
    assert.deepEqual(outcome.result, { title: 'T', maker: 'M', cover: 'C' })
    assert.deepEqual(outcome.matchedFields, ['title', 'maker', 'cover'])
    assert.deepEqual(outcome.warnings, [])
  })

  it('aborts on the first plugin error when policy is abort', async () => {
    await assert.rejects(
      () =>
        runCompositeFieldGroups<Field, Result>({
          fieldPluginMap,
          fields: ['title', 'cover'],
          onPluginError: 'abort',
          runPlugin: async (pluginName) => {
            if (pluginName === 'Alpha') throw new Error('boom')
            return { cover: 'C' }
          },
          pick: (result) => result,
          merge: (base, next) => ({ ...(base ?? {}), ...next })
        }),
      /boom/
    )
  })

  it('collects per-plugin warnings and continues when policy is collect', async () => {
    const outcome = await runCompositeFieldGroups<Field, Result>({
      fieldPluginMap,
      fields: ['title', 'cover'],
      onPluginError: 'collect',
      runPlugin: async (pluginName) => {
        if (pluginName === 'Alpha') throw new Error('alpha down')
        return { cover: 'C' }
      },
      pick: (result, fields) => {
        const out: Result = {}
        if (fields.includes('cover')) out.cover = result.cover
        return out
      },
      merge: (base, next) => ({ ...(base ?? {}), ...next })
    })

    assert.deepEqual(outcome.result, { cover: 'C' })
    assert.deepEqual(outcome.matchedFields, ['cover'])
    assert.deepEqual(outcome.warnings, ['字段源「Alpha」失败：alpha down'])
  })

  it('throws when every grouped source fails under collect policy', async () => {
    await assert.rejects(
      () =>
        runCompositeFieldGroups<Field, Result>({
          fieldPluginMap,
          fields: ['title', 'cover'],
          onPluginError: 'collect',
          runPlugin: async (pluginName) => {
            throw new Error(`${pluginName} failed`)
          },
          pick: (result) => result,
          merge: (base, next) => ({ ...(base ?? {}), ...next })
        }),
      /字段源「Alpha」失败：Alpha failed；字段源「Beta」失败：Beta failed/
    )
  })

  it('returns a null result when every plugin yields no match', async () => {
    const outcome = await runCompositeFieldGroups<Field, Result>({
      fieldPluginMap,
      fields: ['title', 'cover'],
      onPluginError: 'abort',
      runPlugin: async () => null,
      pick: (result) => result,
      merge: (base, next) => ({ ...(base ?? {}), ...next })
    })
    assert.equal(outcome.result, null)
    assert.deepEqual(outcome.matchedFields, [])
  })
})
