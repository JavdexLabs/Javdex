import { createServer } from 'node:http'
import fs from 'node:fs'

// Deterministic model transport only. Browser extraction and catalog writes stay real.
export async function startPlaylistFixture(output) {
  let count = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<html><body><h1>GUI matching list</h1><article><a href="/video/GUI-901"><span class="code">GUI-901</span><span class="title">Existing movie</span></a></article><p id="last">Last page</p></body></html>')
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    fs.writeFileSync(`${output}/playlist-model-${count}.json`, JSON.stringify(body, null, 2))
    const text = JSON.stringify(body.messages ?? [])
    const refs = [...text.matchAll(/(?:evidenceRef|artifactRef)\\?"\s*:\s*\\?"([^"\\]+)/g)]
    let tool
    if (count === 0) tool = { name: 'browser', arguments: { action: 'open', url: `http://${process.env.JAVDEX_PLAYLIST_FIXTURE_HOST ?? '127.0.0.1'}:${server.address().port}/list` } }
    else if (count === 1) tool = { name: 'browser', arguments: { action: 'snapshot' } }
    else if (count === 2 && refs.length) tool = { name: 'checkpoint_playlist_page', arguments: {
      kind: 'static-page', evidenceRef: refs.at(-1)[1], suggestedPlaylistName: 'GUI matching list',
      extraction: { candidateSelector: 'article', detailLinkSelector: 'a', codeSelector: '.code', titleSelector: '.title' },
      advance: { kind: 'terminal', reason: 'explicit-last-page', selector: '#last' }, declaredTotalItems: 1, declaredTotalPages: 1
    } }
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${count}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: 'The current page has been processed.' }
    const common = { id: `chatcmpl-fixture-${count++}`, object: 'chat.completion.chunk', created: 1, model: 'gui-fixture' }
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, process.env.JAVDEX_PLAYLIST_FIXTURE_HOST ?? '127.0.0.1', resolve))
  return { url: `http://${process.env.JAVDEX_PLAYLIST_FIXTURE_HOST ?? '127.0.0.1'}:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}
