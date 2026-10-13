import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const guardSchema = z.object({ id: z.uuid(), phase: z.enum(['verifying', 'active']) }).strict()

/** A missing or damaged guard never activates a pending update. */
export function readUpdateGuard(dataDir: string, jobId: string | undefined): 'normal' | 'verifying' | 'active' {
  const file = path.join(dataDir, 'server-update-guard.json')
  if (!jobId && !fs.existsSync(file)) return 'normal'
  if (jobId) z.uuid().parse(jobId)
  try {
    const guard = guardSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (jobId && guard.id !== jobId) throw new Error('更新任务标识不一致')
    if (!jobId && guard.phase === 'verifying') throw new Error('待验证更新须通过助手启动')
    return guard.phase
  } catch { throw new Error('更新维护标记缺失或损坏，请通过更新助手恢复') }
}
