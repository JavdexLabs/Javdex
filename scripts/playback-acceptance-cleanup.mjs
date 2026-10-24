// Pure acceptance verdict; importing it must not initialize or download a GUI runtime.
import assert from 'node:assert/strict'

export function assertOrdinaryAcceptanceExit(cleanup) {
  assert.equal(cleanup.forced, false, 'acceptance host must close without forced termination')
  assert.equal(cleanup.code, 0, 'acceptance host must exit successfully')
  assert.equal(cleanup.signal, null, 'acceptance host must not exit from a signal')
}

export function recordAcceptanceCleanup(report, cleanup) {
  report.cleanup = cleanup
  if (cleanup.forced || cleanup.code !== 0 || cleanup.signal !== null) {
    report.status = 'failed'
    report.error ??= 'acceptance host did not exit normally'
    process.exitCode = 1
  }
}

/** Keep the original failure and always persist the real host exit verdict. */
export async function closeAcceptanceAndSave(report, application, close, save) {
  try {
    if (application) {
      report.cleanup = await close(application)
      assertOrdinaryAcceptanceExit(report.cleanup)
    }
  } catch (error) {
    report.passed = false
    report.error ??= error.stack ?? String(error)
    throw error
  } finally { save() }
}
