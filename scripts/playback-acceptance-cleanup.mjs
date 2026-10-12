// Pure acceptance verdict; importing it must not initialize or download a GUI runtime.
export function recordAcceptanceCleanup(report, cleanup) {
  report.cleanup = cleanup
  if (cleanup.forced || cleanup.code !== 0 || cleanup.signal !== null) {
    report.status = 'failed'
    report.error ??= 'acceptance host did not exit normally'
    process.exitCode = 1
  }
}
