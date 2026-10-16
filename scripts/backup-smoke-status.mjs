import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

class BackupSmokeHttpError extends Error {
  constructor(status, body) {
    super(`Backup smoke HTTP ${status}: ${body}`)
    this.status = status
    this.body = body
  }
}

export async function readBackupSmokeResponse(response) {
  const body = await response.text()
  if (response.status !== 200) throw new BackupSmokeHttpError(response.status, body)
  return JSON.parse(body)
}

/** Poll only durable backup status; never replay a restore or transfer. */
export async function waitForBackupPhase(post, id, phase, sleep = delay) {
  for (let i = 0; i < 200; i++) {
    let result
    try { result = await post('backup.control', { action: 'status', id }) }
    catch (error) {
      const gatewayGap = error instanceof BackupSmokeHttpError && error.status === 503 &&
        error.body === '服务暂不可用，更新入口仍可访问'
      if (!(error instanceof TypeError) && !gatewayGap) throw error
      await sleep(100)
      continue
    }
    const job = result?.jobs?.[0]
    assert.ok(job && typeof job.phase === 'string', 'invalid backup status response')
    if (job.phase === phase) return job
    assert.ok(!['failed', 'recoveryRequired'].includes(job.phase), job.error)
    await sleep(50)
  }
  assert.fail(`timeout: ${phase}`)
}
