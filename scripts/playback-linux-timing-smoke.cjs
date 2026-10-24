// Real helper/render-clock contract check. Requires a GPU and a local AV fixture;
// run with Electron's ELECTRON_RUN_AS_NODE=1 to match playback-fd.node's ABI.
// Immediate release ACKs do not establish final GUI presentation or A/V sync.
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawn } = require('node:child_process')
const [runtimePath, mediaPath] = process.argv.slice(2)
assert(runtimePath && mediaPath, 'Pass runtime directory and local media fixture')
const runtime = path.resolve(runtimePath)
const bridge = require(path.join(runtime, 'playback-fd.node'))
const channel = bridge.createChannel()
const helper = spawn(path.join(runtime, 'playback-dmabuf-helper'), ['--stdio-v1'], {
  env: process.env, stdio: ['pipe', 'pipe', 'pipe', channel.childFd]
})
bridge.close(channel.childFd)
helper.stdout.resume(); helper.stderr.resume()
function send(fields) {
  const values = fields.map(v => Buffer.from(String(v)))
  const buffer = Buffer.alloc(8 + values.reduce((n, v) => n + 4 + v.length, 0))
  buffer.writeUInt32LE(buffer.length - 4); buffer.writeUInt32LE(values.length, 4)
  let offset = 8
  for (const v of values) { buffer.writeUInt32LE(v.length, offset); offset += 4; v.copy(buffer, offset); offset += v.length }
  helper.stdin.write(buffer)
}
let count = 0, frames = 0, failure, stopping = false, exited = false
const start = performance.now()
const stop = () => { if (!stopping) { stopping = true; clearInterval(timer); send(['destroy']); helper.stdin.end() } }
const timer = setInterval(() => {
  try {
    let packet
    while ((packet = bridge.receive(channel.parentFd))) {
      try {
        const f = JSON.parse(packet.metadata)
        frames++
        assert(Number.isSafeInteger(f.renderStartUs) && f.renderStartUs > 0)
        assert(Number.isSafeInteger(f.targetTimeUs) && f.targetTimeUs >= 0)
        if (f.targetTimeUs) {
          count++
          const lead = (f.targetTimeUs - f.renderStartUs) / 1000
          assert(lead > -1000 && lead < 100, `Render API target units/epoch invalid: ${lead}ms`)
          const age = Number(process.hrtime.bigint()) / 1e6 - f.renderStartUs / 1000
          assert(age >= -2 && age < 1000, `Helper/Node monotonic epochs differ: ${age}ms`)
        }
        bridge.sendAck(channel.parentFd, f.sequence)
      } finally { bridge.close(packet.fd) }
    }
    if (performance.now() - start > 4000) { assert(count >= 10, 'No timed video frames received'); stop() }
  } catch (error) { failure = error; stop() }
}, 1)
helper.on('error', error => { failure = error; clearInterval(timer) })
helper.on('exit', code => {
  exited = true; clearInterval(timer); bridge.close(channel.parentFd)
  if (failure || code !== 0 || !stopping) { console.error(failure ?? `Unexpected helper exit ${code}`); process.exitCode = 1 }
  else console.log(JSON.stringify({ frames, timedFrames: count, clockContract: 'passed', guiAcceptance: false }))
})
setTimeout(() => { if (!exited) { failure = new Error('Helper timed out'); helper.kill('SIGKILL') } }, 8000).unref()
send(['create', '0', '0', '0', '640', '360', '1', 'dmabuf'])
send(['visible', '1'])
send(['command', 'loadfile', path.resolve(mediaPath), 'replace'])
send(['command', 'set', 'pause', 'no'])
