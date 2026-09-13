import assert from 'node:assert/strict'
import { it } from 'node:test'
import { resolveFrozenTargetSlots } from './resolveFrozenTargetSlots'

it('keeps deleted frozen ids in place instead of compacting the page', async () => {
  const slots = await resolveFrozenTargetSlots([11, 12, 13], async (id) => {
    if (id === 12) return null
    return { id, code: `M11-${id}` }
  })
  assert.deepEqual(
    slots.map((slot) => slot.status),
    ['ready', 'missing', 'ready']
  )
  assert.equal(slots[1]?.id, 12)
  assert.equal(slots[0]?.status === 'ready' ? slots[0].value.code : null, 'M11-11')
  assert.equal(slots[2]?.status === 'ready' ? slots[2].value.code : null, 'M11-13')
})
