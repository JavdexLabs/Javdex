import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fallbackPointerTiming } from '@shared/desktop/input'
import { readPointerTiming } from './pointerTiming'

test('Windows and Linux use Chromium Aura click timing without querying desktop preferences', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    assert.deepEqual(await readPointerTiming(platform, async () => assert.fail('must not query AppKit')), { doubleClickMs: 500, source: 'chromium' })
  }
})

test('macOS adapts to the AppKit interval, including slower accessibility settings', async () => {
  for (const [raw, expected] of [['0.25', 250], ['0.8\n', 800], ['1.5', 1500], ['0.5001', 501], ['5', 5000]] as const)
    assert.deepEqual(await readPointerTiming('darwin', async () => raw), { doubleClickMs: expected, source: 'system' })
})

test('failed or malformed native timing uses a bounded conservative fallback', async () => {
  for (const raw of ['', 'NaN', 'Infinity', '0', '-1', '5.1', 'diagnostic output\n0.5'])
    assert.deepEqual(await readPointerTiming('darwin', async () => raw), fallbackPointerTiming)
  assert.deepEqual(await readPointerTiming('darwin', async () => { throw new Error('query timed out') }), fallbackPointerTiming)
  assert.deepEqual(await readPointerTiming('freebsd'), fallbackPointerTiming)
})
