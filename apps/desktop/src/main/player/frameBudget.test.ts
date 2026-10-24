import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameBudget } from './frameBudget'

test('sustained upstream drops learn a bounded floor beyond measured render work', () => {
  const budget = new FrameBudget()
  budget.observeDrops(0, true, 0)
  assert.equal(budget.observeDrops(10, true, 1999), undefined)
  assert.equal(budget.value, 20)
  assert.equal(budget.observeDrops(12, true, 2000), 24)
  for (let i = 0; i < 300; i++) budget.observe(1, 2001 + i * 34)
  assert.equal(budget.value, 24, 'fast rendering cannot erase observed upstream headroom')
  for (let i = 1; i <= 20; i++) budget.observeDrops(12 + i * 10, true, 14000 + i * 2000)
  assert.equal(budget.value, 40)
  budget.reset(true); assert.equal(budget.value, 40, 'a seek within the same GPU host retains learned headroom')
  budget.reset(); assert.equal(budget.value, 20)
  for (let i = 0; i < 1000; i++) budget.observe(1, 100000 + i * 34)
  assert.ok(budget.value <= 9, 'a new timing epoch can learn a cheap path again')
})

test('paused, invalid, isolated and reset drop counters do not inflate the budget', () => {
  const budget = new FrameBudget()
  budget.observeDrops(50, true, 0)
  budget.observeDrops(51, true, 2000)
  assert.equal(budget.value, 20, 'one startup or redraw drop is not sustained pressure')
  budget.observeDrops(100, false, 4000)
  budget.observeDrops(150, true, 6000)
  assert.equal(budget.observeDrops(151, true, 8000), undefined)
  budget.observeDrops(0, true, 10000)
  budget.observeDrops(1, true, 12000)
  for (const count of [undefined, NaN, Infinity, -1, 1.5]) budget.observeDrops(count, true, 14000)
  assert.equal(budget.value, 20)
})

test('drop pressure at the upper bound still records the learned floor', () => {
  const budget = new FrameBudget()
  for (let i = 0; i < 1000; i++) budget.observe(90, i * 34)
  assert.equal(budget.value, 40)
  budget.observeDrops(0, true, 40000); budget.observeDrops(4, true, 42000)
  for (let i = 0; i < 1000; i++) budget.observe(1, 44000 + i * 34)
  assert.equal(budget.value, 40)
})

test('sparse recurring drops accumulate while isolated old pressure expires', () => {
  const budget = new FrameBudget()
  budget.observeDrops(0, true, 0)
  assert.equal(budget.observeDrops(1, true, 2000), undefined)
  assert.equal(budget.observeDrops(1, true, 4000), undefined)
  assert.equal(budget.observeDrops(2, true, 6000), 24)
  assert.equal(budget.observeDrops(3, true, 8000), undefined)
  assert.equal(budget.observeDrops(3, true, 16000), undefined)
  assert.equal(budget.observeDrops(4, true, 18000), undefined, 'an isolated drop from the expired window cannot pair with a new one')
  assert.equal(budget.observeDrops(5, true, 20000), 28)
})
