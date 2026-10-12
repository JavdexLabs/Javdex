import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSubtitleLog } from './subtitleLog'

test('subtitle diagnostics cap entries, evict old content and clear previous sessions', () => {
  const log = createSubtitleLog(1024)
  log.write('旧会话', 'old transcript')
  for (let i = 0; i < 12; i++) log.write('响应', `${i}:` + '文'.repeat(2000))
  const text = log.text()
  assert.ok(text.length < 1300)
  assert.match(text, /已截断/)
  assert.match(text, /已淘汰/)
  assert.match(text, /11:/)
  assert.doesNotMatch(text, /old transcript/)
  log.clear()
  assert.match(log.text(), /暂无推理记录/)
  assert.doesNotMatch(log.text(), /11:/)
})

test('formatted log pairs subtitles, marks pending translation and escapes model output', () => {
  const log = createSubtitleLog()
  log.write('原始响应', '<script>alert(1)</script>')
  log.update([{ start: 2, end: 4, japanese: '<img src=x onerror=alert(1)>', chinese: '你好' },
    { start: 5, end: 6, japanese: 'はい' }], '翻译未完成')
  const html = log.html()
  assert.match(html, /00:00:02.000 — 00:00:04.000/)
  assert.match(html, /识别原文 · 日语/)
  assert.match(html, /你好/)
  assert.match(html, /尚未完成翻译/)
  assert.match(html, /<details><summary>原始诊断日志/)
  assert.doesNotMatch(html, /<script>|<img /)
  assert.match(html, /&lt;img/)
  log.clear()
  assert.doesNotMatch(log.html(), /你好/)
})
