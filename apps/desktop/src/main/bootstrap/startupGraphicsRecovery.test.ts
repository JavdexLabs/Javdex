import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStartupGraphicsRecovery, SOFTWARE_STARTUP_FLAG, softwareStartupRequested, type StartupDiagnostic, type StartupGpuExit } from './startupGraphicsRecovery'

const fault: StartupGpuExit = { type: 'GPU', reason: 'launch-failed', exitCode: 17 }
function fixture(argv = ['electron', '/app/main.js']) {
  const logs: StartupDiagnostic[] = [], launches: string[][] = [], failures: string[] = []
  let disabled = 0, quits = 0, retryGpu: (() => void) | undefined, relaunchError = false
  const recovery = createStartupGraphicsRecovery({
    disableHardwareAcceleration() { disabled++ },
    relaunch(args) { if (relaunchError) throw new Error('spawn failed'); launches.push(args) },
    quit() { quits++ }, record: value => logs.push(value), failed: code => failures.push(code),
    recovered: retry => { retryGpu = retry }
  }, argv)
  recovery.configure()
  return { recovery, logs, launches, failures, disabled: () => disabled, quits: () => quits, retryGpu: () => retryGpu?.(),
    failRelaunch: () => { relaunchError = true } }
}

test('ordinary startup preserves GPU and healthy/runtime GPU exits never restart the app', () => {
  const f = fixture(); f.recovery.claimPrimary(true); f.recovery.windowReady(); f.recovery.gpuExited(fault)
  assert.equal(f.disabled(), 0); assert.equal(f.launches.length, 0); assert.equal(f.quits(), 0)
})
for (const reason of ['crashed', 'abnormal-exit', 'launch-failed', 'integrity-failure'])
  test(`GPU ${reason} during startup restarts once into the shared software mode`, () => {
    const f = fixture(); f.recovery.claimPrimary(true); f.recovery.gpuExited({ ...fault, reason })
    f.recovery.gpuExited(fault); f.recovery.startupFailed(new Error('cancelled import'))
    assert.equal(f.launches.length, 1); assert.equal(f.quits(), 1); assert.equal(f.recovery.canContinue(), false)
    assert.deepEqual(f.launches[0], ['/app/main.js', SOFTWARE_STARTUP_FLAG, '--javdex-startup-recovery=1'])
    const next = fixture(['electron', ...f.launches[0]]); next.recovery.claimPrimary(true)
    assert.equal(next.disabled(), 1)
    next.recovery.gpuExited(fault); next.recovery.gpuExited(fault)
    assert.deepEqual(next.failures, ['SOFTWARE_STARTUP_FAILED']); assert.equal(next.quits(), 1)
    assert.equal(next.launches.length, 0, 'a second automatic relaunch is forbidden')
  })
test('pre-lock GPU fault is deferred and a secondary instance cannot relaunch the primary', () => {
  for (const primary of [false, true]) {
    const f = fixture(); f.recovery.gpuExited(fault)
    assert.equal(f.launches.length, 0)
    f.recovery.claimPrimary(primary)
    assert.equal(f.launches.length, primary ? 1 : 0)
  }
})
for (const reason of ['clean-exit', 'killed', 'oom', 'memory-eviction', 'unknown'])
  test(`${reason} alone does not justify disabling graphics`, () => {
    const f = fixture(); f.recovery.claimPrimary(true)
    f.recovery.gpuExited({ ...fault, reason }); assert.equal(f.launches.length, 0)
    assert.equal(f.recovery.canContinue(), true)
  })
for (const type of ['Utility', 'Zygote', 'Sandbox helper', 'Unknown'])
  test(`${type} failure is not a GPU startup failure`, () => {
    const f = fixture(); f.recovery.claimPrimary(true); f.recovery.gpuExited({ ...fault, type })
    assert.equal(f.launches.length, 0)
  })
test('database/import/load errors report a terminal startup failure regardless of GPU-like text', () => {
  const f = fixture(); f.recovery.claimPrimary(true)
  f.recovery.startupFailed(new Error('GPU database could not open')); f.recovery.gpuExited(fault)
  assert.deepEqual(f.failures, ['APP_STARTUP_FAILED']); assert.equal(f.launches.length, 0); assert.equal(f.quits(), 1)
  assert.equal(f.logs.find(v => v.code === 'APP_STARTUP_ERROR')?.error, 'GPU database could not open')
})
for (const flag of [SOFTWARE_STARTUP_FLAG, '--javdex-startup-recovery=1', '--javdex-startup-recovery=invalid', '--disable-gpu'])
  test(`${flag}: an already software startup cannot enter an automatic retry loop`, () => {
    const f = fixture(['electron', '/app/main.js', flag]); f.recovery.claimPrimary(true); f.recovery.gpuExited(fault)
    assert.equal(f.disabled(), 1); assert.equal(f.launches.length, 0)
    assert.deepEqual(f.failures, ['SOFTWARE_STARTUP_FAILED'])
  })
test('relaunch preserves entry, display choice, user data and literal separator arguments', () => {
  const literal = ['--', '--javdex-software', '--javdex-startup-recovery=1', '影片.mkv']
  const f = fixture(['electron', '/app/main.js', '--javdex-wayland', '--user-data-dir=/profile a', ...literal])
  f.recovery.claimPrimary(true); f.recovery.gpuExited(fault)
  assert.deepEqual(f.launches[0], ['/app/main.js', '--javdex-wayland', '--user-data-dir=/profile a',
    SOFTWARE_STARTUP_FLAG, '--javdex-startup-recovery=1', ...literal])
  const next = fixture(['electron', ...f.launches[0]]); next.recovery.claimPrimary(true); next.recovery.windowReady(); next.retryGpu(); next.retryGpu()
  assert.deepEqual(next.launches, [['/app/main.js', '--javdex-wayland', '--user-data-dir=/profile a', ...literal]])
  assert.equal(next.quits(), 1)
})
test('switch-looking media arguments after -- do not force software startup', () => {
  assert.equal(softwareStartupRequested(['electron', '--', SOFTWARE_STARTUP_FLAG, '--javdex-startup-recovery=1']), false)
})
test('failed relaunch is terminal and stopping startup never launches another instance', () => {
  const f = fixture(); f.recovery.claimPrimary(true); f.failRelaunch(); f.recovery.gpuExited(fault)
  assert.deepEqual(f.failures, ['RELAUNCH_FAILED']); assert.equal(f.quits(), 1)
  const stopped = fixture(); stopped.recovery.claimPrimary(true); stopped.recovery.stop(); stopped.recovery.gpuExited(fault)
  assert.equal(stopped.launches.length, 0)
})
test('unavailable diagnostics and failure UI cannot prevent the terminal exit', () => {
  let quits = 0
  const r = createStartupGraphicsRecovery({ disableHardwareAcceleration() {}, relaunch() {},
    quit() { quits++ }, record() { throw Error('read-only log directory') },
    failed() { throw Error('dialog unavailable') }, recovered() {}
  }, ['electron', SOFTWARE_STARTUP_FLAG])
  assert.doesNotThrow(() => { r.configure(); r.claimPrimary(true); r.gpuExited(fault) })
  assert.equal(quits, 1)
})

test('a synchronous recovery-dialog failure cannot crash a successfully restored window', () => {
  const logs: string[] = []
  const r = createStartupGraphicsRecovery({ disableHardwareAcceleration() {}, relaunch() {},
    quit() { assert.fail('a diagnostic dialog must not close the app') }, record: value => { logs.push(value.code) },
    failed() {}, recovered() { throw new Error('dialog unavailable') }
  }, ['electron', '--javdex-startup-recovery=1'])
  r.configure(); r.claimPrimary(true)
  assert.doesNotThrow(r.windowReady)
  assert.equal(r.canContinue(), true)
  assert.ok(logs.includes('RECOVERY_DIALOG_UNAVAILABLE'))
})
