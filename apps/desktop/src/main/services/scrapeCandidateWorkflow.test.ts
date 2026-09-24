import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runActressCandidateWorkflow, runVideoCandidateWorkflow } from './scrapeCandidateWorkflow'
import type { VideoCandidatePlan } from './scrapeCandidateWorkflow'
import type { collectVideoScrape } from '../scrapers/scraperManager'
import type { CollectedActressScrape } from '../scrapers/actressScraperManager'
import type { VideoMetadataCandidate } from '../metadata-sources'

type VideoRun = Awaited<ReturnType<typeof collectVideoScrape>>

function candidate(title: string): VideoMetadataCandidate {
  return {
    result: { code: 'ABC-123', title },
    assets: [{ kind: 'remote-url', field: 'cover', position: 0, url: `https://example.test/${title}.jpg` }],
    evidence: { kind: 'web-scraper', sourceId: 'site', sourceName: 'Site' }
  }
}

function videoRun(candidates = [candidate('one')]): VideoRun {
  return {
    resolvedScraperName: 'Site',
    descriptor: undefined,
    source: { descriptor: { kind: 'web-scraper' } } as VideoRun['source'],
    sourceName: 'Site',
    ratingSourceName: 'Rating site',
    collected: { candidates, warnings: ['collection warning'] },
    compositeOutcome: null,
    requested: ['title']
  }
}

const videoInput = { videoId: 7, code: 'ABC-123', fields: ['title'] as ['title'] }

function videoPorts(run: VideoRun, review: string[] | null = null) {
  const events: string[] = []
  let saved: VideoCandidatePlan | undefined
  const ports = {
    collect: async (input: Parameters<typeof collectVideoScrape>[0]) => {
      assert.equal(input.videoId, 7)
      events.push('collect')
      return run
    },
    markFailed: () => { events.push('failed') },
    prepare: (plan: VideoCandidatePlan) => {
      saved = plan
      events.push('prepare')
      return { revision: 12 }
    },
    reviewWarnings: () => review,
    pending: async (plan: VideoCandidatePlan, context: { revision: number }, warnings: string[]) => {
      assert.equal(context.revision, 12)
      saved = plan
      events.push('pending')
      return { ok: true, pending: true, skipped: true, warnings }
    },
    apply: async (plan: VideoCandidatePlan, context: { revision: number }) => {
      assert.equal(context.revision, 12)
      saved = plan
      events.push('apply')
      return { ok: true, result: plan.candidate.result, warnings: plan.run.collected.warnings }
    }
  }
  return { ports, events, plan: () => saved! }
}

describe('shared video candidate orchestration', () => {
  it('dispatches a unique candidate with host context and preserves local/remote apply field policies', async () => {
    for (const local of [false, true]) {
      const fixture = videoPorts(videoRun())
      const outcome = await runVideoCandidateWorkflow({
        ...videoInput,
        ...(local ? { singleSourceFieldsToApply: ['title', 'cover'] as ['title', 'cover'] } : {})
      }, fixture.ports)
      assert.deepEqual(fixture.events, ['collect', 'prepare', 'apply'])
      assert.deepEqual(fixture.plan().fieldsToApply, local ? ['title', 'cover'] : ['title'])
      assert.equal(outcome.result?.title, 'one')
      assert.deepEqual(outcome.warnings, ['collection warning'])
    }
  })

  it('retains all candidates and unselected assets for pending review without applying the first', async () => {
    const run = videoRun([candidate('one'), candidate('two')])
    const fixture = videoPorts(run)
    const outcome = await runVideoCandidateWorkflow(videoInput, fixture.ports)
    assert.deepEqual(fixture.events, ['collect', 'prepare', 'pending'])
    assert.equal(outcome.pending, true)
    assert.equal(fixture.plan().sources[0].candidates, run.collected.candidates)
    assert.equal(fixture.plan().sources[0].candidates[1].assets[0].field, 'cover')
    assert.deepEqual(fixture.plan().sources[0].selectedFields, ['title'])
  })

  it('routes a unique local identity conflict to review with ordered warnings', async () => {
    const fixture = videoPorts(videoRun(), ['identity conflict'])
    const outcome = await runVideoCandidateWorkflow(videoInput, fixture.ports)
    assert.deepEqual(fixture.events, ['collect', 'prepare', 'pending'])
    assert.deepEqual(outcome.warnings, ['collection warning', 'identity conflict'])
  })

  it('uses per-source ambiguity and matched fields for composite candidates', async () => {
    const run = videoRun()
    run.source = null
    run.compositeOutcome = {
      result: run.collected.candidates[0].result,
      assets: [], matchedFields: ['title'], warnings: [], quietNoMatch: false,
      sources: [{
        pluginName: 'Titles', descriptor: undefined,
        selectedFields: ['title'], supportedFields: new Set(['title', 'cover']),
        candidates: [candidate('one'), candidate('two')]
      }]
    }
    const fixture = videoPorts(run)
    await runVideoCandidateWorkflow({ ...videoInput, singleSourceFieldsToApply: ['title', 'cover'] }, fixture.ports)
    assert.deepEqual(fixture.events, ['collect', 'prepare', 'pending'])
    assert.deepEqual(fixture.plan().fieldsToApply, ['title'])
    assert.equal(fixture.plan().sources[0].sourceName, 'Titles')
    assert.deepEqual(fixture.plan().sources[0].supportedFields, ['title', 'cover'])
  })

  it('keeps local NFO and NFO-only composite no-match quiet', async () => {
    for (const composite of [false, true]) {
      const run = videoRun([])
      run.source = composite ? null : { descriptor: { kind: 'local-nfo' } } as VideoRun['source']
      if (composite) run.compositeOutcome = {
        result: null, assets: [], matchedFields: [], sources: [], warnings: [], quietNoMatch: true
      }
      const fixture = videoPorts(run)
      const outcome = await runVideoCandidateWorkflow(videoInput, fixture.ports)
      assert.deepEqual(fixture.events, ['collect'])
      assert.deepEqual(outcome, { ok: true, skipped: true, warnings: ['collection warning'] })
    }
  })

  it('records an ordinary web no-match before returning its warnings', async () => {
    const fixture = videoPorts(videoRun([]))
    const outcome = await runVideoCandidateWorkflow(videoInput, fixture.ports)
    assert.deepEqual(fixture.events, ['collect', 'failed'])
    assert.deepEqual(outcome, { ok: false, error: '未找到匹配的元数据', warnings: ['collection warning'] })
  })
})

const actressInput = {
  mainName: 'Name', aliases: ['Alias'], nameZh: '中文', queryName: 'Query', useAliases: true,
  fields: ['nameZh'] as ['nameZh'], requested: ['nameZh', 'avatar'] as ['nameZh', 'avatar']
}

function actressCandidate(): CollectedActressScrape {
  return {
    selectedScraperName: 'Profiles', descriptor: undefined, queryName: 'Query',
    result: { nameZh: '中文' }, sourceWarnings: ['source warning'],
    fieldsToApply: ['nameZh', 'avatar'], resources: []
  }
}

describe('shared actress candidate orchestration', () => {
  it('preserves query inputs, resources, warnings and intersects applicable fields for either host', async () => {
    for (const remote of [false, true]) {
      const events: string[] = []
      const prepared = actressCandidate()
      const outcome = await runActressCandidateWorkflow(actressInput, {
        collect: async (input) => {
          assert.equal(input, actressInput)
          events.push('collect')
          return prepared
        },
        markFailed: () => assert.fail('matched candidate must not be marked failed'),
        persist: (value) => {
          assert.deepEqual(value.applicableFields, ['nameZh'])
          assert.equal(value.resources, prepared.resources)
          assert.equal(value.sourceWarnings, prepared.sourceWarnings)
          events.push('persist')
          const result = { status: 'success' as const, ok: true as const, result: value.result }
          return remote ? Promise.resolve().then(() => { events.push('settled'); return result }) : result
        },
        onError: () => assert.fail('no error expected'),
        close: () => { events.push('close') }
      })
      assert.equal(outcome.status, 'success')
      assert.deepEqual(events, remote ? ['collect', 'persist', 'settled', 'close'] : ['collect', 'persist', 'close'])
    }
  })

  it('preserves a pending persistence disposition and closes after submission', async () => {
    const disposition = { status: 'pending' as const, ok: true as const, pendingId: 42, result: {} }
    let closed = false
    const outcome = await runActressCandidateWorkflow(actressInput, {
      collect: async () => actressCandidate(), markFailed: () => assert.fail(),
      persist: async () => { assert.equal(closed, false); return disposition },
      onError: () => assert.fail(), close: () => { closed = true }
    })
    assert.equal(outcome, disposition)
    assert.equal(closed, true)
  })

  it('records a normal no-match without invoking persistence and retains source warnings', async () => {
    const events: string[] = []
    const outcome = await runActressCandidateWorkflow(actressInput, {
      collect: async () => ({ ...actressCandidate(), result: null }),
      markFailed: () => { events.push('failed') }, persist: () => assert.fail(),
      onError: () => assert.fail(), close: () => { events.push('close') }
    })
    assert.equal(outcome.status, 'failure')
    assert.deepEqual(outcome.warnings, ['source warning'])
    assert.deepEqual(events, ['failed', 'close'])
  })
})
