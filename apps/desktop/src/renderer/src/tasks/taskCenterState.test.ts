import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SubtitleTaskView } from '@shared/desktop/subtitleTasks'
import { matchesSubtitleFilter, subtitleIsRunning, subtitleNeedsAttention, subtitleProgress } from './taskCenterState'
import { parseTaskTab, taskCenterPath } from './taskCenterRoutes'

test('task categories preserve pending deep links and normalize unknown category values', () => {
  assert.equal(taskCenterPath('pending'), '/pending')
  assert.equal(taskCenterPath(), '/tasks')
  assert.equal(taskCenterPath('subtitles', 'attention'), '/tasks?tab=subtitles&status=attention')
  assert.equal(parseTaskTab('?tab=subtitles&status=attention'), 'subtitles')
  assert.equal(parseTaskTab('?tab=unknown'), 'overview')
})

test('attention and running totals exclude user-paused and queued subtitle jobs', () => {
  const statuses = ['running', 'queued', 'paused', 'failed', 'awaiting-save', 'saving', 'completed', 'cancelled'] as const
  const tasks = statuses.map(status => ({ status }))
  assert.deepEqual(tasks.filter(subtitleNeedsAttention).map(task => task.status), ['failed', 'awaiting-save'])
  assert.deepEqual(tasks.filter(subtitleIsRunning).map(task => task.status), ['running', 'saving'])
  assert.deepEqual(tasks.filter(task => matchesSubtitleFilter(task, 'active')).map(task => task.status), ['running', 'queued', 'paused', 'saving'])
  assert.deepEqual(tasks.filter(task => matchesSubtitleFilter(task, 'finished')).map(task => task.status), ['completed', 'cancelled'])
})

test('bilingual progress does not claim recognition alone completes the subtitle', () => {
  const task = { duration: 100, recognizedSeconds: 100, translatedSeconds: 42, output: 'bilingual' } as SubtitleTaskView
  assert.equal(subtitleProgress(task), 42)
  assert.equal(subtitleProgress({ ...task, output: 'japanese' }), 100)
  assert.equal(subtitleProgress({ ...task, duration: 0 }), null)
  assert.equal(subtitleProgress({ ...task, translatedSeconds: 200, recognizedSeconds: 200 }), 100)
})
