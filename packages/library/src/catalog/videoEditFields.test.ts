import assert from 'node:assert/strict'
import { it } from 'node:test'
import { MANAGE_OPERATION_INPUTS } from '@shared/manage/inputs'
import { videoEditInputFromManageFields } from './videoEditFields'

it('preserves external rating edits through the remote contract and shared mapper', () => {
  const externalRatings = { deletedSources: ['JavDB'], defaultSource: 'DMM' }
  const input = MANAGE_OPERATION_INPUTS['videos.edit'].parse({ videoId: 1, fields: { externalRatings } })
  assert.deepEqual(videoEditInputFromManageFields(input.fields), { externalRatings })
  assert.deepEqual(videoEditInputFromManageFields({ title: 'Title' }), { title: 'Title' })
})
