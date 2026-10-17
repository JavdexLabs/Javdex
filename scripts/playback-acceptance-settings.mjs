import assert from 'node:assert/strict'

// Only the owned acceptance profile is changed, through the product settings API.
export async function prepareNonRecordingPlayback(page) {
  const defaults = await page.evaluate(() => window.api.thisComputer.get())
  assert.equal(defaults.playerPreference, 'builtin', 'fresh installations use built-in playback')
  assert.equal(defaults.resumePlayback, true, 'fresh installations enable resume recording by default')
  const saved = await page.evaluate(() => window.api.thisComputer.update({ resumePlayback: false }))
  assert.equal(saved.settings.resumePlayback, false)
  assert.equal((await page.evaluate(() => window.api.thisComputer.get())).resumePlayback, false,
    'the non-recording scenario explicitly saves its own preference')
}
