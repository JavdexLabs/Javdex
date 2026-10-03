// Read-only traffic observation for the isolated Node-host playback acceptance.
// No URLs, headers, bodies, writer secrets or playback tokens are persisted.
import fs from 'node:fs'
import path from 'node:path'
import { channel } from 'node:diagnostics_channel'

const reportFile = process.env.JAVDEX_PLAYBACK_SERVER_REPORT
if (!reportFile || !path.isAbsolute(reportFile) || !path.basename(path.dirname(reportFile)).startsWith('javdex-playback-acceptance-server-')) {
  throw new Error('Playback server observation requires an isolated acceptance directory')
}
const counters = { requests: 0, playRequests: 0, grantRequests: 0, rangeRequests: 0, partialResponses: 0,
  mediaBytesQueued: 0, activeRequests: 0 }
channel('http.server.request.start').subscribe(({ request, response }) => {
  const play = request.url?.startsWith('/play/v1/') === true
  counters.requests++; counters.activeRequests++
  if (play) {
    counters.playRequests++
    if (request.headers.range) counters.rangeRequests++
    const count = args => {
      const body = args[0]
      if (response.statusCode !== 200 && response.statusCode !== 206) return
      counters.mediaBytesQueued += typeof body === 'string' ? Buffer.byteLength(body)
        : body instanceof Uint8Array ? body.byteLength : 0
    }
    response.write = new Proxy(response.write, { apply(target, receiver, args) { count(args); return Reflect.apply(target, receiver, args) } })
    response.end = new Proxy(response.end, { apply(target, receiver, args) { count(args); return Reflect.apply(target, receiver, args) } })
  }
  if (request.url === '/manage/v1/play.grant') counters.grantRequests++
  let done = false
  const finish = () => {
    if (done) return
    done = true; counters.activeRequests--
    if (play && response.statusCode === 206) counters.partialResponses++
  }
  response.once('finish', finish); response.once('close', finish)
})
const write = () => fs.writeFileSync(reportFile, JSON.stringify(counters), { mode: 0o600 })
const timer = setInterval(write, 500)
timer.unref()
write()
process.on('exit', write)
