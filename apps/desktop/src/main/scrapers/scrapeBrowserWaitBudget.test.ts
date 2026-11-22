import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ScrapeBrowserWaitBudget } from './scrapeBrowserWaitBudget'

const clear = { detected: false }
const strictChallenge = { detected: true }
const relaxedChallenge = { detected: true, relaxed: true }

describe('ScrapeBrowserWaitBudget', () => {
  it('holds a strict challenge even when an expected selector is visible', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 180_000)
    assert.equal(budget.update(0, { ...strictChallenge, expectedContent: true }), 'waiting-for-verification')
    assert.equal(budget.update(1200, clear), 'active')
    assert.equal(budget.update(2800, clear), 'active')
    assert.equal(budget.update(3700, clear), 'page-timeout')
  })

  it('still enforces the page timeout while no challenge is active', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 180_000)
    assert.equal(budget.update(2499, clear), 'active')
    assert.equal(budget.update(2500, clear), 'page-timeout')
  })

  it('defers a relaxed challenge while looking for the expected content', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 3000)
    assert.equal(budget.update(2499, relaxedChallenge), 'active')
    assert.equal(budget.update(2500, { ...relaxedChallenge, expectedContent: true }), 'page-timeout')
    assert.equal(budget.update(2510, relaxedChallenge), 'waiting-for-verification')
    assert.equal(budget.update(3000, { ...relaxedChallenge, confirmed: true }), 'active')
    assert.equal(budget.update(5499, relaxedChallenge), 'active')
    assert.equal(budget.update(5500, relaxedChallenge), 'waiting-for-verification')
    assert.equal(budget.update(8010, relaxedChallenge), 'verification-timeout')
  })

  it('switches from strict waiting to relaxed checks on manual confirmation', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 1000, 3000)
    assert.equal(budget.update(100, strictChallenge), 'waiting-for-verification')
    assert.equal(budget.update(1000, { ...relaxedChallenge, confirmed: true }), 'active')
    assert.equal(budget.update(1899, relaxedChallenge), 'active')
    assert.equal(budget.update(1900, relaxedChallenge), 'waiting-for-verification')
    assert.equal(budget.update(4000, relaxedChallenge), 'verification-timeout')
  })

  it('caps manual verification independently from the page timeout', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 3000)
    assert.equal(budget.update(0, strictChallenge), 'waiting-for-verification')
    assert.equal(budget.update(2999, strictChallenge), 'waiting-for-verification')
    assert.equal(budget.update(3000, strictChallenge), 'verification-timeout')
  })
})
