import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  scanActressFaceTargets,
  type ActressFaceScanProgress,
  type ActressFaceScanTarget
} from './scanQueue'
import type { ActressFaceScanCache } from './cache'

const targets: ActressFaceScanTarget[] = [
  { actressId: 1, mainName: 'A', avatarUrl: 'media://a', fingerprint: 'a' },
  { actressId: 2, mainName: 'B', avatarUrl: 'media://b', fingerprint: 'b' },
  { actressId: 3, mainName: 'C', avatarUrl: 'media://c', fingerprint: 'c' }
]

describe('actress face scan queue', () => {
  it('reuses cached face statuses and does not invoke detection for them', async () => {
    const cache: ActressFaceScanCache = new Map([
      [1, { fingerprint: 'a', status: 'without-face' }]
    ])
    const detected: number[] = []
    const result = await scanActressFaceTargets(
      targets,
      cache,
      async (target) => {
        detected.push(target.actressId)
        return 'has-face'
      },
      () => false,
      () => undefined
    )

    assert.deepEqual(detected, [2, 3])
    assert.equal(result.reused, 1)
    assert.deepEqual(result.withoutFaceIds, [1])
    assert.equal(result.failed, 0)
  })

  it('finishes the current target before honoring cancellation', async () => {
    let cancel = false
    const progress: ActressFaceScanProgress[] = []
    const result = await scanActressFaceTargets(
      targets,
      new Map(),
      async (target) => {
        if (target.actressId === 1) cancel = true
        return 'without-face'
      },
      () => cancel,
      (next) => progress.push(next)
    )

    assert.equal(result.cancelled, true)
    assert.equal(result.current, 1)
    assert.deepEqual(result.withoutFaceIds, [1])
    assert.equal(progress.at(-1)?.status, 'cancelling')
  })

  it('does not cache detector failures so a later run can retry them', async () => {
    const cache: ActressFaceScanCache = new Map()
    const result = await scanActressFaceTargets(
      [targets[0]],
      cache,
      async () => {
        throw new Error('读取失败')
      },
      () => false,
      () => undefined
    )

    assert.equal(result.failed, 1)
    assert.equal(cache.size, 0)
  })
})
