import assert from 'node:assert/strict'
import { it } from 'node:test'
import { highlightJavaScript } from './highlightJavaScript'

const classes = {
  keyword: 'local-keyword',
  string: 'local-string',
  comment: 'local-comment',
  number: 'local-number',
  function: 'local-function'
}

it('uses the caller-owned syntax classes and escapes source text', () => {
  const html = highlightJavaScript('const title = "<video>&"; // note\nparse(42)', classes)
  assert.match(html, /<span class="local-keyword">const<\/span>/)
  assert.match(html, /<span class="local-string">"&lt;video&gt;&amp;"<\/span>/)
  assert.match(html, /<span class="local-comment">\/\/ note<\/span>/)
  assert.match(html, /<span class="local-function">parse<\/span>/)
  assert.match(html, /<span class="local-number">42<\/span>/)
  assert.doesNotMatch(html, /code-hl-|<video>/)
})
