import fs from 'node:fs'
import path from 'node:path'

const sourceRoot = path.resolve('apps/desktop/src')
const piRoot = path.resolve('apps/desktop/src/main/agent-runtime/pi')
const sourceFiles = []

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) visit(target)
    else if (/\.(ts|tsx)$/.test(entry.name)) sourceFiles.push(target)
  }
}

visit(sourceRoot)
const errors = []
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const relative = path.relative(process.cwd(), file).replaceAll('\\', '/')
  if (text.includes('@earendil-works/pi-') && !file.startsWith(`${piRoot}${path.sep}`)) {
    errors.push(`${relative}: Pi import 必须局限在 apps/desktop/src/main/agent-runtime/pi/`)
  }
  if (/\bPI_CACHE_RETENTION\b/.test(text)) {
    errors.push(`${relative}: 禁止使用进程级 PI_CACHE_RETENTION`)
  }
}

const executionFile = path.resolve('apps/desktop/src/main/agent-platform/agentExecution.ts')
const execution = fs.readFileSync(executionFile, 'utf8')
for (const forbidden of ['agentMessages', 'contextCompress', 'agentToolChatClient']) {
  if (execution.includes(forbidden)) errors.push(`agentExecution.ts: 禁止依赖 ${forbidden}`)
}
for (const forbiddenFile of [
  'apps/desktop/src/main/services/pluginDevAgent/agentMessages.ts',
  'apps/desktop/src/main/services/pluginDevAgent/contextCompress.ts',
  'apps/desktop/src/main/services/llm/agentToolChatClient.ts',
  'apps/desktop/src/main/services/pluginDevAgent/runner.ts'
]) {
  if (fs.existsSync(forbiddenFile)) errors.push(`${forbiddenFile}: legacy Agent runtime 必须退役`)
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Agent platform boundaries OK')
}
