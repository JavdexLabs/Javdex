import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_STRM_BYTES,
  StrmParseError,
  isStrmFile,
  parseStrmContent
} from './strmParser'

function bytes(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

function assertParseError(content: Uint8Array, code: StrmParseError['code']): void {
  assert.throws(
    () => parseStrmContent('/library/ABC-001.strm', content),
    (error: unknown) => error instanceof StrmParseError && error.code === code
  )
}

describe('STRM parser', () => {
  it('matches the STRM extension without case sensitivity', () => {
    assert.equal(isStrmFile('/library/ABC-001.strm'), true)
    assert.equal(isStrmFile('/library/ABC-001.STRM'), true)
    assert.equal(isStrmFile('/library/ABC-001.strm.txt'), false)
  })

  it('accepts one HTTP target after BOM, blank lines, comments, and Kodi properties', () => {
    const parsed = parseStrmContent(
      '/library/ABC-001.strm',
      bytes('\ufeff\r\n # comment\r\n#KODIPROP:inputstream=inputstream.adaptive\r\n https://example.com/video.mp4?token=secret#preview \r\n')
    )

    assert.deepEqual(parsed, {
      kind: 'direct',
      locator: 'https://example.com/video.mp4?token=secret',
      targetKey: 'http:https://example.com/video.mp4?token=secret'
    })
  })

  it('normalizes supported HTTP, Magnet, and ED2K targets through the resource contract', () => {
    assert.equal(
      parseStrmContent('/library/web.strm', bytes('https://example.com/watch?id=1')).kind,
      'web'
    )
    assert.deepEqual(
      parseStrmContent(
        '/library/magnet.strm',
        bytes('magnet:?xt=urn:btih:ABCDEF0123456789&dn=Display')
      ),
      {
        kind: 'magnet',
        locator: 'magnet:?xt=urn:btih:ABCDEF0123456789&dn=Display',
        targetKey: 'magnet:btih:abcdef0123456789'
      }
    )
    assert.deepEqual(
      parseStrmContent(
        '/library/ed2k.strm',
        bytes('ed2k://|file|Example.mp4|1024|ABCDEF0123456789ABCDEF0123456789|/')
      ),
      {
        kind: 'ed2k',
        locator: 'ed2k://|file|Example.mp4|1024|ABCDEF0123456789ABCDEF0123456789|/',
        targetKey: 'ed2k:abcdef0123456789abcdef0123456789'
      }
    )
  })

  it('rejects empty, multiple-target, invalid UTF-8, and unsupported-protocol content', () => {
    assertParseError(bytes('\n# comment\n'), 'missing_target')
    assertParseError(
      bytes('https://example.com/one.mp4\nhttps://example.com/two.mp4'),
      'multiple_targets'
    )
    assertParseError(Uint8Array.from([0xc3, 0x28]), 'invalid_utf8')
    for (const target of [
      '/local/video.mp4',
      'file:///local/video.mp4',
      'smb://server/share/video.mp4',
      'rtsp://example.com/video',
      'mms://example.com/video',
      'plugin://example/video'
    ]) {
      assertParseError(bytes(target), 'unsupported_target')
    }
  })

  it('accepts exactly 1 MiB and rejects larger input without truncation', () => {
    const target = 'https://example.com/video.mp4\n'
    const exact = bytes(`${target}#${'x'.repeat(MAX_STRM_BYTES - Buffer.byteLength(target) - 1)}`)
    assert.equal(exact.byteLength, MAX_STRM_BYTES)
    assert.equal(parseStrmContent('/library/ABC-001.strm', exact).kind, 'direct')

    assertParseError(Buffer.concat([exact, Buffer.from('x')]), 'too_large')
  })
})
