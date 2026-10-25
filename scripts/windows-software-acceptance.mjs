import assert from 'node:assert/strict'

assert.equal(process.platform, 'win32')
await import('./software-playback-acceptance.mjs')
