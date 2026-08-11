import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { assertPublicHttpUrl } from './publicHttpUrl'
import { fetchPublicHttpBuffer, fetchPublicHttpHead } from './publicHttpFetch'

describe('public HTTP fetch', () => {
  it('rejects private literals and hostnames resolving to private addresses', async () => {
    await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1/image.jpg'), /内网地址/)
    await assert.rejects(
      () => assertPublicHttpUrl('https://image.example/test.jpg', async () => [
        { address: '169.254.169.254', family: 4 }
      ]),
      /内网地址/
    )
    await assert.rejects(
      () => assertPublicHttpUrl('https://user:secret@image.example/test.jpg'),
      /用户名或密码/
    )
    await assert.rejects(
      () => assertPublicHttpUrl('http://[fec0::1]/image.jpg'),
      /内网地址/
    )
    await assert.rejects(
      () => assertPublicHttpUrl('http://[64:ff9b:1::1]/image.jpg'),
      /内网地址/
    )
    await assert.doesNotReject(() =>
      assertPublicHttpUrl('https://image.example/test.jpg', async () => [
        { address: '93.184.216.34', family: 4 }
      ])
    )
  })

  it('connects to the validated address while preserving the logical host', async () => {
    let requestHost = ''
    const server = http.createServer((request, response) => {
      requestHost = request.headers.host ?? ''
      response.setHeader('content-length', '4')
      if (request.method === 'HEAD') response.end()
      else response.end('test')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const port = (server.address() as AddressInfo).port
      const logicalUrl = `http://public.example:${port}/asset`
      const validateUrl = async (url: string) => ({
        url: new URL(url),
        addresses: [{ address: '127.0.0.1', family: 4 }]
      })

      assert.deepEqual(
        await fetchPublicHttpBuffer(logicalUrl, { validateUrl }),
        Buffer.from('test')
      )
      assert.equal(requestHost, `public.example:${port}`)

      assert.deepEqual(await fetchPublicHttpHead(logicalUrl, { validateUrl }), {
        status: 200,
        ok: true,
        sizeBytes: 4
      })
      assert.equal(requestHost, `public.example:${port}`)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('validates redirect destinations and caps streamed response bytes', async () => {
    const validateUrl = async (url: string): Promise<URL> => {
      if (url.includes('private.example')) throw new Error('链接不能访问本机或内网地址')
      return new URL(url)
    }
    await assert.rejects(
      () =>
        fetchPublicHttpBuffer('https://public.example/image.jpg', {
          validateUrl,
          fetchImpl: async () =>
            new Response(null, {
              status: 302,
              headers: { location: 'http://private.example/image.jpg' }
            })
        }),
      /内网地址/
    )

    await assert.rejects(
      () =>
        fetchPublicHttpBuffer('https://public.example/image.jpg', {
          validateUrl,
          maxBytes: 3,
          fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3, 4]))
        }),
      /图片文件过大/
    )
  })

  it('applies one timeout budget to URL validation and the request', async () => {
    const startedAt = Date.now()
    await assert.rejects(
      () =>
        fetchPublicHttpBuffer('https://public.example/image.jpg', {
          timeoutMs: 30,
          validateUrl: async (url) => {
            await new Promise((resolve) => setTimeout(resolve, 80))
            return new URL(url)
          },
          fetchImpl: async () => new Response('late')
        }),
      /请求超时/
    )
    assert.equal(Date.now() - startedAt < 70, true)
  })

  it('closes a pending SOCKS connection when the request deadline expires', async () => {
    const sockets = new Set<Socket>()
    const proxy = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.resume()
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })

    try {
      const port = (proxy.address() as AddressInfo).port
      await assert.rejects(
        () =>
          fetchPublicHttpBuffer('http://public.example/image.jpg', {
            timeoutMs: 40,
            proxyUrl: `socks5://127.0.0.1:${port}`,
            validateUrl: async (url) => ({
              url: new URL(url),
              addresses: [{ address: '93.184.216.34', family: 4 }]
            })
          }),
        /超时|取消|timed out/i
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(sockets.size, 0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
