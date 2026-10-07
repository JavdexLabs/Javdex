import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createSubtitleScheduler, type SubtitleSchedulerState } from './subtitleScheduler'
import type { SubtitleChunk } from './subtitleCache'

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await delay(5) }
  assert.fail('scheduler did not reach expected state')
}
test('seek cancels irrelevant inference and publishes only new priority results', async () => {
  const starts: number[] = [], states: SubtitleSchedulerState[] = []
  let active = 0, peak = 0, aborted = false
  const scheduler = createSubtitleScheduler(180, {
    read: async () => null, write: async () => {},
    recognize: async (start, end, signal) => {
      starts.push(start); active++; peak = Math.max(peak, active)
      try { await delay(start === 0 ? 500 : 1, undefined, { signal }); return [{ start, end, japanese: String(start) }] }
      catch (error) { aborted = true; throw error }
      finally { active-- }
    },
    translate: async cues => cues.map(cue => ({ ...cue, chinese: '译文' })), changed: state => states.push(state)
  })
  scheduler.start(); await until(() => starts.length === 1)
  scheduler.position(125); await until(() => starts.length > 1)
  assert.equal(aborted, true); assert.deepEqual(starts.slice(0, 2), [0, 120]); assert.equal(peak, 1)
  await scheduler.stop()
  assert.ok(!states.some(state => state.cues.some(cue => cue.japanese === '0')))
})
test('cached Japanese survives translation failure and retry never repeats recognition', async () => {
  let stored: SubtitleChunk | null = null, recognizes = 0, translations = 0
  const states: SubtitleSchedulerState[] = []
  const scheduler = createSubtitleScheduler(15, {
    read: async () => stored, write: async value => { stored = structuredClone(value) },
    recognize: async () => { recognizes++; return [{ start: 0, end: 2, japanese: 'こんにちは' }] },
    translate: async cues => { translations++; if (translations === 1) throw new Error('offline engine failure'); return cues.map(cue => ({ ...cue, chinese: '你好' })) },
    changed: state => states.push(state)
  })
  scheduler.start(); await until(() => states.at(-1)?.phase === 'error')
  assert.equal(states.at(-1)?.cues[0].japanese, 'こんにちは')
  assert.equal(states.at(-1)?.recognizedSeconds, 15)
  scheduler.retry(); await until(() => states.at(-1)?.translatedSeconds === 15)
  assert.equal(recognizes, 1); assert.equal(translations, 2); assert.equal(states.at(-1)?.error, null)
  await scheduler.stop()
})
test('complete cached chunks load without starting either model', async () => {
  const states: SubtitleSchedulerState[] = []
  const scheduler = createSubtitleScheduler(45, {
    read: async index => ({ index, translated: true, cues: [{ start: index * 30, end: index * 30 + 1, japanese: 'はい', chinese: '是' }] }),
    write: async () => assert.fail('complete cache must not be rewritten'),
    recognize: async () => assert.fail('must reuse recognition'), translate: async () => assert.fail('must reuse translation'),
    changed: state => states.push(state)
  })
  scheduler.position(35); scheduler.start(); await until(() => states.at(-1)?.translatedSeconds === 45)
  assert.equal(states.at(-1)?.cues[0].start, 30)
  await scheduler.stop()
})
