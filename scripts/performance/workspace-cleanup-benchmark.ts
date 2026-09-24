import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginWorkspaceModule } from '../../apps/desktop/src/main/services/pluginDevAgent/pluginWorkspace'

it('measures event-loop responsiveness during real synthetic workspace deletion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-cleanup-benchmark-'))
  const results = []
  try {
    for (const files of [1000, 10_000]) {
      for (const variant of ['sync-baseline', 'async-current'] as const) {
        const workspace = path.join(root, `${files}-${variant}`)
        for (let index = 0; index < files; index++) {
          const directory = path.join(workspace, String(Math.floor(index / 100)))
          if (index % 100 === 0) fs.mkdirSync(directory, { recursive: true })
          fs.writeFileSync(path.join(directory, `${index}.txt`), 'synthetic workspace fixture')
        }
        let ticks = 0
        let maximumTickGapMs = 0
        let lastTick = performance.now()
        let finished = false
        let firstTimerBeforeFinished = false
        const timerProbe = new Promise<void>((resolve) => setTimeout(() => {
          firstTimerBeforeFinished = !finished
          resolve()
        }, 0))
        const timer = setInterval(() => {
          const now = performance.now()
          maximumTickGapMs = Math.max(maximumTickGapMs, now - lastTick)
          lastTick = now
          ticks++
        }, 5)
        const started = performance.now()
        try {
          if (variant === 'sync-baseline') fs.rmSync(workspace, { recursive: true, force: true })
          else await new PluginWorkspaceModule().remove(workspace)
          finished = true
          const elapsedMs = performance.now() - started
          await timerProbe
          await new Promise((resolve) => setTimeout(resolve, 6))
          assert.equal(fs.existsSync(workspace), false)
          if (variant === 'async-current') assert.equal(firstTimerBeforeFinished, true)
          else assert.equal(firstTimerBeforeFinished, false)
          results.push({ files, variant, elapsedMs, firstTimerBeforeFinished, ticks, maximumTickGapMs })
        } finally { clearInterval(timer) }
      }
    }
    const output = JSON.stringify({ measuredAt: new Date().toISOString(), runtime: process.versions, results,
      notes: ['One local macOS temporary-directory sample per case. Synthetic small files; OS cache not evicted.',
        'Sync baseline reproduces the old rmSync call; async current executes PluginWorkspaceModule.remove.',
        'Timer responsiveness and wall time, not p95, memory, native request-count bounds or Windows/HDD acceptance.',
        'Synchronous fixture construction is outside the measured interval.'] }, null, 2) + '\n'
    if (process.env.JAVDEX_CLEANUP_BENCH_OUTPUT) fs.writeFileSync(process.env.JAVDEX_CLEANUP_BENCH_OUTPUT, output)
    else process.stdout.write(output)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
