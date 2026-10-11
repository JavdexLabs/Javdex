import assert from 'node:assert/strict'
import { it } from 'node:test'
import { MANAGE_OPERATION_INPUTS } from '@shared/manage/inputs'
import { videoEditInputFromManageFields } from './videoEditFields'

it('preserves external rating edits through the remote contract and shared mapper', () => {
  const externalRatings = { deletedSources: ['JavDB'], defaultSource: 'DMM', entries: [
    { originalSource: null, source: 'DMM', ratingAverage: 4.5, ratingCount: null },
    { originalSource: 'Library', source: 'JavLibrary', ratingAverage: 3.5, ratingCount: 10 }
  ] }
  const input = MANAGE_OPERATION_INPUTS['videos.edit'].parse({ videoId: 1, fields: { externalRatings } })
  assert.deepEqual(videoEditInputFromManageFields(input.fields), { externalRatings })
  assert.deepEqual(videoEditInputFromManageFields({ title: 'Title' }), { title: 'Title' })
})

it('validates rating numbers and source names at the management boundary and accepts legacy selections', () => {
  const externalRatings = { deletedSources: [], defaultSource: null }
  assert.ok(MANAGE_OPERATION_INPUTS['videos.edit'].safeParse({ videoId: 1, fields: { externalRatings } }).success)
  const entry = { originalSource: null, source: 'Manual', ratingAverage: 4.5, ratingCount: null }
  for (const bad of [
    { source: ' ' }, { source: 'a'.repeat(257) }, { ratingAverage: Infinity }, { ratingAverage: -1 },
    { ratingCount: -1 }, { ratingCount: 1.5 }, { ratingCount: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.equal(MANAGE_OPERATION_INPUTS['videos.edit'].safeParse({
      videoId: 1, fields: { externalRatings: { ...externalRatings, entries: [{ ...entry, ...bad }] } }
    }).success, false)
  }
})
