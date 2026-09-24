import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canResolveScrapePage,
  canResolveScrapeSelector,
  ScrapeBrowserWaitBudget
} from './scrapeBrowserWaitBudget'

describe('scrape browser readiness', () => {
  it('does not resolve an intermediate verification page even when it has matching content', () => {
    assert.equal(canResolveScrapePage(true, true), false)
    assert.equal(canResolveScrapePage(false, false), false)
    assert.equal(canResolveScrapePage(false, true), true)
  })

  it('does not accept selectors found on a verification page', () => {
    assert.equal(canResolveScrapeSelector(true, true), false)
    assert.equal(canResolveScrapeSelector(false, true), true)
  })
})

describe('ScrapeBrowserWaitBudget', () => {
  it('does not consume the page timeout while Cloudflare verification is active', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 180_000)

    assert.equal(budget.update(0, true), 'active')
    assert.equal(budget.update(1200, false), 'active')
    assert.equal(budget.update(2800, false), 'active')
    assert.equal(budget.update(3700, false), 'page-timeout')
  })

  it('still enforces the page timeout while no challenge is active', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 180_000)

    assert.equal(budget.update(2499, false), 'active')
    assert.equal(budget.update(2500, false), 'page-timeout')
  })

  it('caps manual verification independently from the page timeout', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 2500, 3000)

    assert.equal(budget.update(0, true), 'active')
    assert.equal(budget.update(2999, true), 'active')
    assert.equal(budget.update(3000, true), 'verification-timeout')
  })

  it('accumulates the verification cap across repeated challenge periods', () => {
    const budget = new ScrapeBrowserWaitBudget(0, 1000, 3000)

    assert.equal(budget.update(0, true), 'active')
    assert.equal(budget.update(1000, false), 'active')
    assert.equal(budget.update(1500, true), 'active')
    assert.equal(budget.update(3499, true), 'active')
    assert.equal(budget.update(3500, true), 'verification-timeout')
  })
})
