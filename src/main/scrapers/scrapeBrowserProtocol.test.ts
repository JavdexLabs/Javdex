import assert from 'node:assert/strict'
import fs from 'node:fs'
import net, { type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  SCRAPE_BROWSER_MAX_FRAME_BYTES,
  SCRAPE_BROWSER_PROTOCOL_VERSION,
  ScrapeBrowserFramedSocket,
  assertScrapeBrowserHello,
  type ScrapeBrowserHelloFrame,
  type ScrapeBrowserProtocolFrame
} from './scrapeBrowserProtocol'

const sockets: ScrapeBrowserFramedSocket[] = []
const pipePaths: string[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const pipePath of pipePaths.splice(0)) fs.rmSync(pipePath, { force: true })
})

async function socketPair(): Promise<[Socket, Socket]> {
  const pipePath = path.join(
    process.platform === 'darwin' ? '/tmp' : os.tmpdir(),
    `jdf-${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e6)}.sock`
  )
  pipePaths.push(pipePath)
  const server = net.createServer()
  const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipePath, resolve)
  })
  const client = net.createConnection(pipePath)
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  const remote = await accepted
  server.close()
  return [client, remote]
}

describe('ScrapeBrowserFramedSocket', () => {
  it('rejects the wrong token, parent pid, protocol version or CDP port', () => {
    const hello: ScrapeBrowserHelloFrame = {
      type: 'hello' as const,
      protocolVersion: SCRAPE_BROWSER_PROTOCOL_VERSION,
      token: 'a'.repeat(64),
      pid: 10,
      parentPid: 9,
      cdpPort: 12345,
      targetId: 'target'
    }
    assert.doesNotThrow(() => assertScrapeBrowserHello(hello, {
      token: hello.token,
      parentPid: 9,
      cdpPort: 12345,
      childPid: 10
    }))
    assert.throws(() => assertScrapeBrowserHello({ ...hello, token: 'b'.repeat(64) }, {
      token: hello.token,
      parentPid: 9,
      cdpPort: 12345,
      childPid: 10
    }), /握手认证失败/)
    assert.throws(() => assertScrapeBrowserHello({ ...hello, parentPid: 8 }, {
      token: hello.token,
      parentPid: 9,
      cdpPort: 12345
    }), /握手认证失败/)
    assert.throws(() => assertScrapeBrowserHello({
      ...hello,
      protocolVersion: 999 as typeof SCRAPE_BROWSER_PROTOCOL_VERSION
    }, {
      token: hello.token,
      parentPid: 9,
      cdpPort: 12345
    }), /握手认证失败/)
    assert.throws(() => assertScrapeBrowserHello({ ...hello, cdpPort: 12346 }, {
      token: hello.token,
      parentPid: 9,
      cdpPort: 12345
    }), /握手认证失败/)
  })

  it('round-trips authenticated hello frames and native Buffers', async () => {
    const [client, remote] = await socketPair()
    const frames: ScrapeBrowserProtocolFrame[] = []
    const received = new Promise<void>((resolve, reject) => {
      const receiver = new ScrapeBrowserFramedSocket(remote, (frame) => {
        frames.push(frame)
        if (frames.length === 2) resolve()
      }, reject)
      sockets.push(receiver)
    })
    const sender = new ScrapeBrowserFramedSocket(client, () => undefined, () => undefined)
    sockets.push(sender)
    sender.send({
      type: 'hello',
      protocolVersion: SCRAPE_BROWSER_PROTOCOL_VERSION,
      token: 'a'.repeat(64),
      pid: 10,
      parentPid: 9,
      cdpPort: 12345,
      targetId: 'target'
    })
    sender.send({
      type: 'response',
      id: '1',
      ok: true,
      value: { body: Buffer.from([0, 1, 2, 255]) }
    })
    await received
    assert.equal(frames[0].type, 'hello')
    assert.ok(frames[1].type === 'response' && frames[1].value)
    const body = (frames[1] as { value: { body: Buffer } }).value.body
    assert.deepEqual([...body], [0, 1, 2, 255])
  })

  it('rejects an oversized incoming frame before allocating its body', async () => {
    const [client, remote] = await socketPair()
    const failed = new Promise<Error>((resolve) => {
      const receiver = new ScrapeBrowserFramedSocket(remote, () => undefined, resolve)
      sockets.push(receiver)
    })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(SCRAPE_BROWSER_MAX_FRAME_BYTES + 1)
    client.write(header)
    const error = await failed
    assert.match(error.message, /frame length is invalid/)
    client.destroy()
  })
})
