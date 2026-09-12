import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createProgressPublisher } from './progressPublisher'

it('coalesces a large burst and flushes the final value without leaking a timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  const values: number[] = []
  const publisher = createProgressPublisher<number>(value => values.push(value), 100, () => now)
  for (let value = 1; value <= 300382; value++) publisher.update(value)
  assert.deepEqual(values, [1])
  now = 100
  t.mock.timers.tick(100)
  assert.deepEqual(values, [1, 300382])
  publisher.update(300383)
  publisher.close()
  assert.deepEqual(values, [1, 300382, 300383])
  publisher.update(300384)
  publisher.close()
  t.mock.timers.tick(1000)
  assert.deepEqual(values, [1, 300382, 300383])
})

it('limits continuous progress to ten updates per second plus the final flush', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  const values: Array<{ time: number; value: number }> = []
  const publisher = createProgressPublisher<number>(value => values.push({ time: now, value }), 100, () => now)
  for (let index = 0; index < 1000; index++) {
    publisher.update(index)
    now++
    t.mock.timers.tick(1)
  }
  const periodic = values.slice()
  assert.ok(periodic.length <= 11)
  for (let index = 1; index < periodic.length; index++) {
    assert.ok(periodic[index].time - periodic[index - 1].time >= 100)
  }
  publisher.close()
  assert.equal(values.at(-1)?.value, 999)
})

it('replaces pending progress with an immediate state and can publish the next state', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const values: string[] = []
  const publisher = createProgressPublisher<string>(value => values.push(value), 100, () => 0)
  publisher.update('running')
  publisher.update('pending')
  publisher.update('cancelled', true)
  publisher.update('idle', true)
  publisher.close()
  t.mock.timers.tick(1000)
  assert.deepEqual(values, ['running', 'cancelled', 'idle'])
})
