import assert from 'node:assert/strict'
import { it } from 'node:test'
import { detectDefaultPlayer } from './defaultPlayerService'

it('detects a Unicode executable without executing it or its association command', async () => {
  const program = 'D:\\播放器 软件\\Player.exe'
  const result = await detectDefaultPlayer({ platform: 'win32', query: async () => JSON.stringify({ path: program, extension: '.mp4' }), isFile: async value => value === program })
  assert.deepEqual(result, { status: 'found', path: program, extension: '.mp4' })
})

it('skips missing files, command strings and shell brokers before trying another extension', async () => {
  const result = await detectDefaultPlayer({ platform: 'win32', query: async () => JSON.stringify([
    { path: 'C:\\missing.exe', extension: '.mp4' },
    { path: 'C:\\Windows\\rundll32.exe', extension: '.mp4' },
    { path: '"C:\\player.exe" "%1"', extension: '.mp4' },
    { path: 'relative.exe', extension: '.mp4' },
    { path: 'C:\\播放器\\player.exe', extension: '.mkv' }
  ]), isFile: async value => !value.includes('missing') })
  assert.deepEqual(result, { status: 'found', path: 'C:\\播放器\\player.exe', extension: '.mkv' })
})

it('offers manual selection when associations are unavailable or detection fails', async () => {
  for (const query of [async () => '', async () => 'bad json', async () => { throw new Error('timeout') }]) {
    const result = await detectDefaultPlayer({ platform: 'win32', query })
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.match(result.message, /选择程序/)
  }
  const result = await detectDefaultPlayer({ platform: 'darwin', query: async () => { throw new Error('must not run') } })
  assert.equal(result.status, 'unavailable')
})
